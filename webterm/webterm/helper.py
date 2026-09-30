"""Privileged helper daemon (runs as root).

The internet facing web server runs as an unprivileged system user and can
neither verify other users' passwords nor start processes as them.  It asks
this helper over a Unix socket instead.  The helper:

* authenticates users with PAM and applies the login policy
  (allowed groups, denied users, no root by default, login shell required);
* hands out a random token for every successful login.  All later requests
  must present a valid token, so the web server can only act on behalf of
  users who actually logged in;
* starts a login shell (``runuser -l <user>``) on a new PTY and passes the
  PTY master back over SCM_RIGHTS.  The web server only ever holds the
  master side of the terminal;
* runs file uploads / downloads as the logged-in user (see fileops.py).

Protocol: one request per connection.  The client sends one JSON line, the
helper answers with one JSON line (optionally carrying one file descriptor).
File operations send a second JSON line when the worker process exits.
"""

from __future__ import annotations

import argparse
import fcntl
import grp
import json
import logging
import os
import pwd
import random
import re
import secrets
import shutil
import signal
import socket
import socketserver
import struct
import subprocess
import sys
import termios
import threading
import time
from dataclasses import dataclass

from . import pam
from .config import DEFAULT_CONFIG_PATH, Config, load_config

log = logging.getLogger("webterm.helper")

MAX_REQUEST = 64 * 1024
USERNAME_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,127}\$?$")
NOLOGIN_SHELLS = {"/sbin/nologin", "/usr/sbin/nologin", "/bin/false", "/usr/bin/false", ""}
FILEOPS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fileops.py")
SAFE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"


class RequestError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass
class Grant:
    user: str
    uid: int
    gid: int
    home: str
    groups: list
    rhost: str
    expires: float


def _find_binary(name: str) -> str:
    path = shutil.which(name, path="/usr/sbin:/usr/bin:/sbin:/bin")
    if not path:
        raise SystemExit(f"required program {name!r} not found")
    return path


class Helper:
    def __init__(self, config: Config):
        self.config = config.helper
        self.grants: dict[str, Grant] = {}
        self.lock = threading.Lock()
        self.runuser = _find_binary("runuser")
        self.setsid = _find_binary("setsid")
        # Seconds a policy denial takes (roughly like a failed PAM attempt).
        self.denial_delay = 2.0
        self.allowed_uids = {0}
        try:
            self.allowed_uids.add(pwd.getpwnam(self.config.client_user).pw_uid)
        except KeyError:
            log.warning("client_user %r does not exist; only root may connect", self.config.client_user)

    # ----------------------------------------------------------------- policy
    def policy_denial(self, user: str) -> str | None:
        """Return why ``user`` may not log in, or None if the policy allows it."""
        cfg = self.config
        if user in cfg.denied_users:
            return "user is in denied_users"
        try:
            pw = pwd.getpwnam(user)
        except KeyError:
            return "no such user"
        if pw.pw_uid == 0 and not cfg.allow_root:
            return "root login is disabled (allow_root = false)"
        if pw.pw_shell in NOLOGIN_SHELLS:
            return "account has no login shell"
        if cfg.allowed_groups:
            member_of = set(os.getgrouplist(pw.pw_name, pw.pw_gid))
            allowed = set()
            for name in cfg.allowed_groups:
                try:
                    allowed.add(grp.getgrnam(name).gr_gid)
                except KeyError:
                    log.warning("allowed group %r does not exist", name)
            if not member_of & allowed:
                return "not a member of " + ",".join(cfg.allowed_groups)
        return None

    def _grant(self, token: object) -> Grant:
        if not isinstance(token, str):
            raise RequestError("invalid_token")
        now = time.monotonic()
        with self.lock:
            grant = self.grants.get(token)
            if grant is None or grant.expires < now:
                self.grants.pop(token, None)
                raise RequestError("invalid_token")
            return grant

    def _purge(self) -> None:
        now = time.monotonic()
        with self.lock:
            for token in [t for t, g in self.grants.items() if g.expires < now]:
                del self.grants[token]

    # -------------------------------------------------------------- operations
    def op_auth(self, req: dict) -> dict:
        user = req.get("user")
        password = req.get("password")
        rhost = str(req.get("rhost") or "")[:64]
        if (
            not isinstance(user, str)
            or not isinstance(password, str)
            or not USERNAME_RE.match(user)
            or "\0" in password
            or len(password) > 4096
        ):
            raise RequestError("auth_failed")

        denial = self.policy_denial(user)
        if denial:
            log.warning("authentication refused; user=%s rhost=%s reason=%s", user, rhost, denial)
            # Take about as long as a failed PAM attempt, and never run PAM
            # for denied users: a fast "success" would reveal their password.
            time.sleep(self.denial_delay * (1 + random.random() / 2))
            raise RequestError("auth_failed")

        result = self.pam_authenticate(user, password, rhost)
        if not result.ok:
            log.warning(
                "authentication failure; user=%s rhost=%s pam=%s", user, rhost, result.reason
            )
            if result.code in (pam.PAM_NEW_AUTHTOK_REQD, pam.PAM_ACCT_EXPIRED):
                raise RequestError("password_expired")
            raise RequestError("auth_failed")

        if result.user != user:
            # A PAM module canonicalised the name; re-apply the policy.
            denial = self.policy_denial(result.user)
            if denial:
                log.warning("authentication refused; user=%s rhost=%s reason=%s", result.user, rhost, denial)
                raise RequestError("auth_failed")
            user = result.user

        grant = self.make_grant(user, rhost)
        token = secrets.token_urlsafe(32)
        self._purge()
        with self.lock:
            self.grants[token] = grant
        log.info("authentication success; user=%s rhost=%s", grant.user, rhost)
        return {"ok": True, "token": token, "user": grant.user, "uid": grant.uid, "home": grant.home}

    # The following methods are separate so that tests can replace them.
    def pam_authenticate(self, user: str, password: str, rhost: str) -> pam.PamResult:
        return pam.authenticate(self.config.pam_service, user, password, rhost=rhost)

    def make_grant(self, user: str, rhost: str) -> Grant:
        pw = pwd.getpwnam(user)
        return Grant(
            user=pw.pw_name,
            uid=pw.pw_uid,
            gid=pw.pw_gid,
            home=pw.pw_dir,
            groups=os.getgrouplist(pw.pw_name, pw.pw_gid),
            rhost=rhost,
            expires=time.monotonic() + self.config.token_lifetime,
        )

    def shell_command(self, grant: Grant) -> list:
        # setsid --ctty makes the PTY the controlling terminal of a new
        # session; runuser -l then runs the PAM session stack and the user's
        # login shell exactly like "su -".  runuser -l clears the environment
        # except TERM, so a configured LANG must be whitelisted explicitly.
        keep = ["--whitelist-environment=LANG"] if self.config.lang else []
        return [self.setsid, "--ctty", "--wait", self.runuser, *keep, "-l", grant.user]

    def credentials(self, grant: Grant) -> dict:
        """Popen arguments that make a file worker run as the user."""
        return {"user": grant.uid, "group": grant.gid, "extra_groups": grant.groups}

    def op_revoke(self, req: dict) -> dict:
        token = req.get("token")
        with self.lock:
            grant = self.grants.pop(token, None) if isinstance(token, str) else None
        if grant:
            log.info("logout; user=%s rhost=%s", grant.user, grant.rhost)
        return {"ok": True}

    def op_spawn(self, req: dict, conn: socket.socket) -> None:
        grant = self._grant(req.get("token"))
        cols = _clamp(req.get("cols"), 10, 1000, 80)
        rows = _clamp(req.get("rows"), 5, 500, 24)

        master, slave = os.openpty()
        try:
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
            env = {"TERM": self.config.term, "PATH": SAFE_PATH}
            if self.config.lang:
                env["LANG"] = self.config.lang
            proc = subprocess.Popen(
                self.shell_command(grant),
                stdin=slave,
                stdout=slave,
                stderr=slave,
                env=env,
                cwd="/",
                close_fds=True,
            )
        except Exception:
            os.close(master)
            raise
        finally:
            os.close(slave)

        try:
            _send(conn, {"ok": True, "pid": proc.pid}, fd=master)
        finally:
            os.close(master)
        log.info("session start; user=%s rhost=%s pid=%d", grant.user, grant.rhost, proc.pid)
        started = time.monotonic()

        def reap() -> None:
            code = proc.wait()
            log.info(
                "session end; user=%s pid=%d status=%d duration=%ds",
                grant.user, proc.pid, code, time.monotonic() - started,
            )

        threading.Thread(target=reap, name=f"reap-{proc.pid}", daemon=True).start()

    def op_fileop(self, req: dict, conn: socket.socket) -> None:
        grant = self._grant(req.get("token"))
        action = req.get("action")
        if action == "upload":
            directory, name = req.get("dir"), req.get("name")
            size, overwrite = req.get("size"), req.get("overwrite")
            if not (_is_path(directory) and _is_path(name) and isinstance(size, int) and size >= 0):
                raise RequestError("bad_request")
            args = ["upload", directory, name, str(size), "1" if overwrite else "0"]
            what = f"dir={directory!r} name={name!r} size={size}"
        elif action in ("download", "stat"):
            path = req.get("path")
            if not _is_path(path):
                raise RequestError("bad_request")
            args = [action, path]
            what = f"path={path!r}"
        else:
            raise RequestError("bad_request")

        home = grant.home if os.path.isdir(grant.home) else "/"
        env = {
            "HOME": grant.home,
            "USER": grant.user,
            "LOGNAME": grant.user,
            "PATH": SAFE_PATH,
            "LANG": "C.UTF-8",
        }
        read_end, write_end = os.pipe()
        if action == "upload":
            child_stdin, child_stdout, client_end = read_end, subprocess.PIPE, write_end
        else:
            child_stdin, child_stdout, client_end = subprocess.DEVNULL, write_end, read_end
        try:
            proc = subprocess.Popen(
                [sys.executable, "-I", "-S", FILEOPS, *args],
                stdin=child_stdin,
                stdout=child_stdout,
                stderr=subprocess.DEVNULL,
                env=env,
                cwd=home,
                umask=0o022,
                start_new_session=True,
                close_fds=True,
                **self.credentials(grant),
            )
        except Exception:
            os.close(client_end)
            raise
        finally:
            # Close the worker's end of the pipe in this process.
            os.close(read_end if client_end == write_end else write_end)

        try:
            _send(conn, {"ok": True}, fd=client_end)
        finally:
            os.close(client_end)

        result = None
        if action == "upload":
            out, _ = proc.communicate()
            try:
                result = json.loads(out.decode().strip().splitlines()[-1])
            except (ValueError, IndexError):
                result = None
        code = proc.wait()
        ok = code == 0
        level = logging.INFO if ok else logging.WARNING
        log.log(level, "file %s %s; user=%s rhost=%s status=%d", action, what, grant.user, grant.rhost, code)
        _send(conn, {"ok": ok, "status": code, "result": result})

    # ---------------------------------------------------------------- dispatch
    def handle(self, conn: socket.socket) -> None:
        creds = conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
        _pid, uid, _gid = struct.unpack("3i", creds)
        if uid not in self.allowed_uids:
            log.error("rejected connection from uid %d", uid)
            return

        conn.settimeout(30)
        data = b""
        while b"\n" not in data:
            chunk = conn.recv(4096)
            if not chunk:
                return
            data += chunk
            if len(data) > MAX_REQUEST:
                _send(conn, {"ok": False, "error": "request_too_large"})
                return
        conn.settimeout(None)
        try:
            req = json.loads(data.split(b"\n", 1)[0])
            if not isinstance(req, dict):
                raise ValueError
        except ValueError:
            _send(conn, {"ok": False, "error": "bad_request"})
            return

        op = req.get("op")
        try:
            if op == "auth":
                _send(conn, self.op_auth(req))
            elif op == "revoke":
                _send(conn, self.op_revoke(req))
            elif op == "spawn":
                self.op_spawn(req, conn)
            elif op == "fileop":
                self.op_fileop(req, conn)
            elif op == "ping":
                _send(conn, {"ok": True})
            else:
                _send(conn, {"ok": False, "error": "unknown_op"})
        except RequestError as exc:
            _send(conn, {"ok": False, "error": exc.code})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            log.exception("error handling %r request", op)
            try:
                _send(conn, {"ok": False, "error": "internal_error"})
            except OSError:
                pass


def _clamp(value: object, low: int, high: int, default: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        return default
    return max(low, min(high, value))


def _is_path(value: object) -> bool:
    return isinstance(value, str) and 0 < len(value) <= 4096 and "\0" not in value


def _send(conn: socket.socket, obj: dict, fd: int | None = None) -> None:
    data = (json.dumps(obj) + "\n").encode()
    if fd is None:
        conn.sendall(data)
    else:
        socket.send_fds(conn, [data], [fd])


class _Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    helper: Helper


class _Handler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        self.server.helper.handle(self.request)  # type: ignore[attr-defined]


def make_server(config: Config, helper: Helper | None = None) -> _Server:
    """Create the listening socket (mode 0660, group ``socket_group``)."""
    cfg = config.helper
    path = cfg.socket
    os.makedirs(os.path.dirname(path), exist_ok=True)
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    old_umask = os.umask(0o177)
    try:
        server = _Server(path, _Handler)
    finally:
        os.umask(old_umask)
    server.helper = helper or Helper(config)
    if os.geteuid() == 0:
        try:
            os.chown(path, 0, grp.getgrnam(cfg.socket_group).gr_gid)
            os.chmod(path, 0o660)
        except KeyError:
            log.warning("socket_group %r does not exist; socket is accessible by root only", cfg.socket_group)
    return server


def serve(config: Config) -> None:
    server = make_server(config)

    def stop(signum, _frame):
        log.info("received signal %d, shutting down", signum)
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    log.info("helper listening on %s (pam service %r)", config.helper.socket, config.helper.pam_service)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        try:
            os.unlink(config.helper.socket)
        except FileNotFoundError:
            pass


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="WebTerm privileged helper")
    parser.add_argument("--config", default=DEFAULT_CONFIG_PATH)
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.debug else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )
    if os.geteuid() != 0:
        raise SystemExit("webterm helper must run as root")
    serve(load_config(args.config))


if __name__ == "__main__":
    main()
