"""aiohttp web server.  Runs as the unprivileged ``webterm`` system user.

Everything that needs root (PAM, starting shells, touching users' files) is
delegated to the helper (see helper.py).  This process serves the UI, keeps
login sessions, and relays terminal I/O between WebSockets and PTY masters.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import hmac
import html
import ipaddress
import json
import logging
import os
import re
import secrets
import socket
import sys
import time
from collections import deque
from dataclasses import dataclass, field
from urllib.parse import quote

from aiohttp import WSMsgType, web

from . import __version__
from .config import DEFAULT_CONFIG_PATH, Config, load_config
from .helper_client import FileTransfer, HelperClient, HelperError
from .ratelimit import LoginLimiter
from .terminal import Terminal

log = logging.getLogger("webterm.web")

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
HIGH_WATER = 1024 * 1024  # stop reading the PTY when this much output is queued
LOW_WATER = 128 * 1024
SEND_CHUNK = 256 * 1024
IO_CHUNK = 256 * 1024
SWEEP_INTERVAL = 15
HOST_RE = re.compile(r"(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?")

FILE_ERROR_STATUS = {
    "exists": 409,
    "not_found": 404,
    "permission_denied": 403,
    "read_only": 403,
    "not_a_directory": 400,
    "is_a_directory": 400,
    "not_a_regular_file": 400,
    "invalid_name": 400,
    "invalid_path": 400,
    "name_too_long": 400,
    "no_space": 507,
    "incomplete": 400,
}

APP_KEY: web.AppKey["WebTerm"] = web.AppKey("webterm")


class ApiError(Exception):
    def __init__(self, status: int, code: str, **extra):
        super().__init__(code)
        self.status = status
        self.code = code
        self.extra = extra


@dataclass
class AuthSession:
    sid: str
    csrf: str
    user: str
    token: str
    home: str
    ip: str
    created: float
    last_active: float
    terminals: dict = field(default_factory=dict)


# --------------------------------------------------------------------------
# Non-blocking pipe helpers (the pipes come from the helper via SCM_RIGHTS)
# --------------------------------------------------------------------------
async def _wait_fd(fd: int, write: bool) -> None:
    loop = asyncio.get_running_loop()
    fut = loop.create_future()

    def ready() -> None:
        if not fut.done():
            fut.set_result(None)

    if write:
        loop.add_writer(fd, ready)
    else:
        loop.add_reader(fd, ready)
    try:
        await fut
    finally:
        if write:
            loop.remove_writer(fd)
        else:
            loop.remove_reader(fd)


async def read_some(fd: int, size: int) -> bytes:
    while True:
        try:
            return os.read(fd, size)
        except BlockingIOError:
            await _wait_fd(fd, False)


async def write_all(fd: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        try:
            written = os.write(fd, view)
        except BlockingIOError:
            await _wait_fd(fd, True)
            continue
        view = view[written:]


async def read_header(fd: int) -> tuple[dict, bytes]:
    """Read the JSON header line written by fileops.py."""
    buf = b""
    while b"\n" not in buf:
        chunk = await read_some(fd, 65536)
        if not chunk:
            raise HelperError("file worker exited without a header")
        buf += chunk
        if len(buf) > 1024 * 1024:
            raise HelperError("file worker header too large")
    line, rest = buf.split(b"\n", 1)
    header = json.loads(line)
    if not isinstance(header, dict):
        raise HelperError("invalid file worker header")
    return header, rest


def content_disposition(name: str) -> str:
    fallback = re.sub(r"[^A-Za-z0-9._-]", "_", name) or "download"
    encoded = quote(name.encode("utf-8", "replace"), safe="")
    return f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{encoded}"


# --------------------------------------------------------------------------
# WebSocket <-> terminal attachment
# --------------------------------------------------------------------------
class Attachment:
    """Connects one WebSocket to one Terminal (implements terminal.Sink)."""

    def __init__(self, app: "WebTerm", ws: web.WebSocketResponse, term: Terminal, session: AuthSession):
        self.app = app
        self.ws = ws
        self.term = term
        self.session = session
        self.data: deque[bytes] = deque()
        self.queued = 0
        self.control: deque[dict] = deque()
        self.event = asyncio.Event()
        self.close_code: int | None = None
        self.close_reason = ""
        self.exited = False

    # Sink interface -------------------------------------------------------
    def feed(self, data: bytes) -> None:
        self.data.append(data)
        self.queued += len(data)
        self.event.set()
        if self.queued > HIGH_WATER:
            self.term.pause()

    def terminal_exited(self) -> None:
        self.exited = True
        self.event.set()

    def kick(self, code: int, reason: str) -> None:
        if self.close_code is None:
            self.close_code = code
            self.close_reason = reason
            self.event.set()

    # ----------------------------------------------------------------------
    async def run(self, offset: int | None) -> None:
        term = self.term
        previous = term.sink
        if isinstance(previous, Attachment) and previous is not self:
            previous.kick(4000, "attached elsewhere")
        start, replay, reset = term.attach(self, offset)
        if replay:
            self.feed(replay)
        hello = {
            "t": "hello",
            "id": term.id,
            "offset": start,
            "reset": reset,
            "idleRemaining": self.app.idle_remaining(self.session),
        }
        sender = asyncio.create_task(self._sender(hello))
        try:
            async for msg in self.ws:
                if msg.type == WSMsgType.BINARY:
                    self.session.last_active = time.monotonic()
                    term.write(msg.data)
                elif msg.type == WSMsgType.TEXT:
                    self._on_control(msg.data)
                elif msg.type == WSMsgType.ERROR:
                    break
        finally:
            term.detach(self)
            sender.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await sender
            if not self.ws.closed:
                with contextlib.suppress(Exception):
                    await self.ws.close()

    def _on_control(self, raw: str) -> None:
        try:
            msg = json.loads(raw)
        except ValueError:
            return
        if not isinstance(msg, dict):
            return
        kind = msg.get("t")
        if kind == "resize":
            cols, rows = msg.get("cols"), msg.get("rows")
            if isinstance(cols, int) and isinstance(rows, int):
                self.term.resize(cols, rows)
        elif kind == "ping":
            self.control.append({"t": "pong", "idleRemaining": self.app.idle_remaining(self.session)})
            self.event.set()

    async def _sender(self, hello: dict) -> None:
        ws = self.ws
        await ws.send_json(hello)
        while True:
            await self.event.wait()
            self.event.clear()
            while self.control:
                await ws.send_json(self.control.popleft())
            while self.data:
                parts, size = [], 0
                while self.data and size < SEND_CHUNK:
                    part = self.data.popleft()
                    parts.append(part)
                    size += len(part)
                self.queued -= size
                await ws.send_bytes(b"".join(parts))
                if self.queued < LOW_WATER and self.term.sink is self:
                    self.term.resume()
            if self.close_code is not None:
                await ws.close(code=self.close_code, message=self.close_reason.encode())
                return
            if self.exited:
                await ws.send_json({"t": "exit"})
                await ws.close(code=1000, message=b"exited")
                return


# --------------------------------------------------------------------------
# Application
# --------------------------------------------------------------------------
class WebTerm:
    def __init__(self, config: Config, helper: HelperClient):
        self.config = config
        self.cfg = config.web
        self.helper = helper
        self.sessions: dict[str, AuthSession] = {}
        self.limiter = LoginLimiter(
            self.cfg.login_max_failures, self.cfg.login_failure_window, self.cfg.login_lockout
        )
        self.auth_slots = asyncio.Semaphore(8)
        self.hostname = socket.gethostname()
        self.trusted = []
        for item in self.cfg.trusted_proxies:
            try:
                self.trusted.append(ipaddress.ip_network(item, strict=False))
            except ValueError:
                log.warning("ignoring invalid trusted_proxies entry %r", item)
        self.allowed_origins = {o.rstrip("/").lower() for o in self.cfg.allowed_origins}
        with open(os.path.join(STATIC_DIR, "index.html"), encoding="utf-8") as fh:
            self.index_html = (
                fh.read()
                .replace("{{TITLE}}", html.escape(self.cfg.title))
                .replace("{{VERSION}}", quote(__version__))
            )
        self._background: set[asyncio.Task] = set()
        self._sweeper: asyncio.Task | None = None

    # ------------------------------------------------------------ utilities
    def _spawn(self, coro) -> None:
        task = asyncio.ensure_future(coro)
        self._background.add(task)
        task.add_done_callback(self._background.discard)

    def _is_trusted(self, addr: str | None) -> bool:
        if not addr:
            return False
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            return False
        return any(ip in net for net in self.trusted)

    def client_ip(self, request: web.Request) -> str:
        peer = request.remote or ""
        if not self._is_trusted(peer):
            return peer
        forwarded = request.headers.get("X-Forwarded-For", "")
        hops = [h.strip() for h in forwarded.split(",") if h.strip()]
        # Walk from the nearest hop; the first address that is not one of our
        # own proxies is the client.
        for hop in reversed(hops):
            if not self._is_trusted(hop):
                return hop
        return hops[0] if hops else peer

    def scheme(self, request: web.Request) -> str:
        if self._is_trusted(request.remote):
            proto = request.headers.get("X-Forwarded-Proto", "").split(",")[0].strip().lower()
            if proto in ("http", "https"):
                return proto
        return request.scheme

    def host(self, request: web.Request) -> str:
        if self._is_trusted(request.remote):
            forwarded = request.headers.get("X-Forwarded-Host", "").split(",")[0].strip()
            if forwarded:
                return forwarded
        return request.host

    def origin_ok(self, request: web.Request) -> bool:
        origin = request.headers.get("Origin")
        if not origin:
            return False
        origin = origin.rstrip("/").lower()
        if self.allowed_origins:
            return origin in self.allowed_origins
        return origin == f"{self.scheme(request)}://{self.host(request)}".lower()

    def idle_remaining(self, s: AuthSession) -> int | None:
        now = time.monotonic()
        left = self.cfg.session_max_lifetime - (now - s.created)
        if self.cfg.session_idle_timeout:
            left = min(left, self.cfg.session_idle_timeout - (now - s.last_active))
        return max(0, int(left))

    def _expired(self, s: AuthSession, now: float) -> bool:
        if now - s.created > self.cfg.session_max_lifetime:
            return True
        return bool(self.cfg.session_idle_timeout) and now - s.last_active > self.cfg.session_idle_timeout

    def get_session(self, request: web.Request, touch: bool = True) -> AuthSession | None:
        sid = request.cookies.get(self.cfg.cookie_name)
        if not sid:
            return None
        s = self.sessions.get(sid)
        if s is None:
            return None
        now = time.monotonic()
        if self._expired(s, now):
            self.destroy_session(s, "expired")
            return None
        if touch:
            s.last_active = now
        return s

    def require_session(self, request: web.Request, csrf: bool) -> AuthSession:
        if csrf and not self.origin_ok(request):
            raise ApiError(403, "bad_origin")
        s = self.get_session(request)
        if s is None:
            raise ApiError(401, "unauthorized")
        if csrf and not hmac.compare_digest(request.headers.get("X-CSRF-Token", ""), s.csrf):
            raise ApiError(403, "bad_csrf_token")
        return s

    def destroy_session(self, s: AuthSession, reason: str) -> None:
        if self.sessions.pop(s.sid, None) is None:
            return
        log.info("session closed; user=%s ip=%s reason=%s", s.user, s.ip, reason)
        for term in s.terminals.values():
            if isinstance(term.sink, Attachment):
                term.sink.kick(4001, "session ended")
            term.close()
        s.terminals.clear()
        self._spawn(self._revoke(s.token))

    async def _revoke(self, token: str) -> None:
        with contextlib.suppress(HelperError):
            await self.helper.call({"op": "revoke", "token": token})

    def _helper_failure(self, s: AuthSession, data: dict, what: str) -> ApiError:
        if data.get("error") == "invalid_token":
            self.destroy_session(s, "helper token no longer valid")
            return ApiError(401, "unauthorized")
        log.error("%s failed for %s: %s", what, s.user, data.get("error"))
        return ApiError(500, data.get("error") or "helper_error")

    async def _json_body(self, request: web.Request) -> dict:
        if not request.can_read_body:
            return {}
        try:
            body = await request.json()
        except (ValueError, UnicodeDecodeError):
            raise ApiError(400, "bad_request") from None
        if not isinstance(body, dict):
            raise ApiError(400, "bad_request")
        return body

    # ---------------------------------------------------------- middleware
    @web.middleware
    async def middleware(self, request: web.Request, handler):
        path = request.path
        if path.startswith(("/api/", "/ws/")) and request.headers.get("Sec-Fetch-Site") == "cross-site":
            return web.json_response({"error": "cross_site_request"}, status=403)
        try:
            return await handler(request)
        except ApiError as exc:
            return web.json_response({"error": exc.code, **exc.extra}, status=exc.status)

    async def on_prepare(self, request: web.Request, response: web.StreamResponse) -> None:
        headers = response.headers
        connect = "'self'"
        host = self.host(request)
        if HOST_RE.fullmatch(host):
            connect += (" wss://" if self.scheme(request) == "https" else " ws://") + host
        headers.setdefault(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            f"img-src 'self' data:; font-src 'self' data:; connect-src {connect}; "
            "frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
        )
        headers.setdefault("X-Content-Type-Options", "nosniff")
        headers.setdefault("X-Frame-Options", "DENY")
        headers.setdefault("Referrer-Policy", "no-referrer")
        headers.setdefault("Cross-Origin-Opener-Policy", "same-origin")
        headers.setdefault("Cross-Origin-Resource-Policy", "same-origin")
        headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()")
        if request.path.startswith("/static/"):
            headers.setdefault("Cache-Control", "public, max-age=86400")
        else:
            headers.setdefault("Cache-Control", "no-store")

    # -------------------------------------------------------------- pages
    async def index(self, request: web.Request) -> web.Response:
        return web.Response(text=self.index_html, content_type="text/html", charset="utf-8")

    async def api_session(self, request: web.Request) -> web.Response:
        s = self.get_session(request)
        data = {
            "authenticated": False,
            "title": self.cfg.title,
            "notice": self.cfg.login_notice,
            "version": __version__,
        }
        if s is not None:
            data.update(
                authenticated=True,
                user=s.user,
                home=s.home,
                csrf=s.csrf,
                hostname=self.hostname,
                idleTimeout=self.cfg.session_idle_timeout,
                idleRemaining=self.idle_remaining(s),
                maxUploadBytes=self.cfg.max_upload_bytes,
                maxTerminals=self.cfg.max_terminals,
            )
        return web.json_response(data)

    # --------------------------------------------------------------- auth
    async def api_login(self, request: web.Request) -> web.Response:
        if not self.origin_ok(request):
            raise ApiError(403, "bad_origin")
        body = await self._json_body(request)
        username, password = body.get("username"), body.get("password")
        if not isinstance(username, str) or not isinstance(password, str):
            raise ApiError(400, "bad_request")
        username = username.strip()
        if not username or not password or len(username) > 128 or len(password) > 4096:
            raise ApiError(400, "bad_request")

        ip = self.client_ip(request)
        keys = (f"ip:{ip}", f"user:{username.lower()}")
        wait = self.limiter.retry_after(*keys)
        if wait:
            log.warning("login throttled; user=%s ip=%s retry_after=%d", username, ip, wait)
            raise ApiError(429, "too_many_attempts", retryAfter=wait)

        async with self.auth_slots:
            try:
                reply = await self.helper.call(
                    {"op": "auth", "user": username, "password": password, "rhost": ip}
                )
            except HelperError as exc:
                log.error("login: %s", exc)
                raise ApiError(503, "helper_unavailable") from None
        data = reply.data
        if not data.get("ok"):
            self.limiter.failure(*keys)
            log.warning("login failed; user=%s ip=%s error=%s", username, ip, data.get("error"))
            code = data.get("error") if data.get("error") == "password_expired" else "auth_failed"
            raise ApiError(401, code)
        self.limiter.success(*keys)

        old = self.get_session(request, touch=False)
        if old is not None:
            self.destroy_session(old, "re-login")
        mine = sorted((x for x in self.sessions.values() if x.user == data["user"]), key=lambda x: x.created)
        while self.cfg.max_sessions_per_user and len(mine) >= self.cfg.max_sessions_per_user:
            self.destroy_session(mine.pop(0), "too many sessions")

        now = time.monotonic()
        s = AuthSession(
            sid=secrets.token_urlsafe(32),
            csrf=secrets.token_urlsafe(32),
            user=data["user"],
            token=data["token"],
            home=data.get("home", ""),
            ip=ip,
            created=now,
            last_active=now,
        )
        self.sessions[s.sid] = s
        log.info("login; user=%s ip=%s", s.user, ip)
        response = web.json_response({"ok": True, "user": s.user})
        response.set_cookie(
            self.cfg.cookie_name,
            s.sid,
            path=self.cfg.cookie_path,
            httponly=True,
            secure=self.cfg.cookie_secure,
            samesite="Strict",
        )
        return response

    async def api_logout(self, request: web.Request) -> web.Response:
        s = self.require_session(request, csrf=True)
        self.destroy_session(s, "logout")
        response = web.json_response({"ok": True})
        response.del_cookie(self.cfg.cookie_name, path=self.cfg.cookie_path)
        return response

    async def api_activity(self, request: web.Request) -> web.Response:
        s = self.require_session(request, csrf=True)
        return web.json_response({"idleRemaining": self.idle_remaining(s)})

    # ---------------------------------------------------------- terminals
    def _prune(self, s: AuthSession) -> None:
        for tid in [tid for tid, t in s.terminals.items() if not t.alive and t.sink is None]:
            del s.terminals[tid]

    async def api_list_terminals(self, request: web.Request) -> web.Response:
        s = self.require_session(request, csrf=False)
        self._prune(s)
        terms = sorted((t for t in s.terminals.values() if t.alive), key=lambda t: t.created)
        return web.json_response({"terminals": [t.info() for t in terms]})

    async def api_create_terminal(self, request: web.Request) -> web.Response:
        s = self.require_session(request, csrf=True)
        body = await self._json_body(request)
        cols = body.get("cols") if isinstance(body.get("cols"), int) else 80
        rows = body.get("rows") if isinstance(body.get("rows"), int) else 24
        self._prune(s)
        if len(s.terminals) >= self.cfg.max_terminals:
            raise ApiError(409, "too_many_terminals", limit=self.cfg.max_terminals)
        try:
            reply = await self.helper.call({"op": "spawn", "token": s.token, "cols": cols, "rows": rows})
        except HelperError as exc:
            log.error("spawn: %s", exc)
            raise ApiError(503, "helper_unavailable") from None
        if not reply.data.get("ok") or reply.fd is None:
            if reply.fd is not None:
                os.close(reply.fd)
            raise self._helper_failure(s, reply.data, "spawn")
        if s.sid not in self.sessions:  # logged out while we were waiting
            os.close(reply.fd)
            raise ApiError(401, "unauthorized")
        term = Terminal(
            reply.fd,
            owner=s.sid,
            scrollback_limit=self.cfg.scrollback_bytes,
            pid=int(reply.data.get("pid") or 0),
            cols=max(10, min(1000, cols)),
            rows=max(5, min(500, rows)),
        )
        s.terminals[term.id] = term
        return web.json_response(term.info(), status=201)

    async def api_close_terminal(self, request: web.Request) -> web.Response:
        s = self.require_session(request, csrf=True)
        term = s.terminals.pop(request.match_info["tid"], None)
        if term is None:
            raise ApiError(404, "not_found")
        if isinstance(term.sink, Attachment):
            term.sink.kick(4004, "terminal closed")
        term.close()
        return web.json_response({"ok": True})

    async def ws_terminal(self, request: web.Request) -> web.WebSocketResponse:
        if not self.origin_ok(request):
            raise ApiError(403, "bad_origin")
        ws = web.WebSocketResponse(max_msg_size=1024 * 1024)
        await ws.prepare(request)
        s = self.get_session(request)
        if s is None:
            await ws.close(code=4001, message=b"unauthorized")
            return ws
        term = s.terminals.get(request.match_info["tid"])
        if term is None or not term.alive:
            s.terminals.pop(request.match_info["tid"], None)
            await ws.close(code=4004, message=b"terminal not found")
            return ws
        try:
            offset: int | None = int(request.query["offset"])
        except (KeyError, ValueError):
            offset = None
        await Attachment(self, ws, term, s).run(offset)
        return ws

    # -------------------------------------------------------------- files
    async def _open_transfer(self, s: AuthSession, request: dict) -> FileTransfer:
        try:
            reply, transfer = await self.helper.open_transfer({"op": "fileop", "token": s.token, **request})
        except HelperError as exc:
            log.error("file transfer: %s", exc)
            raise ApiError(503, "helper_unavailable") from None
        if transfer is None:
            raise self._helper_failure(s, reply, "file transfer")
        os.set_blocking(transfer.fd, False)
        return transfer

    @staticmethod
    def _file_error(code: str | None) -> ApiError:
        code = code or "io_error"
        return ApiError(FILE_ERROR_STATUS.get(code, 500), code)

    async def api_upload(self, request: web.Request) -> web.Response:
        s = self.require_session(request, csrf=True)
        directory = request.query.get("dir") or "~"
        name = request.query.get("name", "")
        overwrite = request.query.get("overwrite") == "1"
        if not name or "/" in name or name in (".", ".."):
            raise ApiError(400, "invalid_name")
        length = request.content_length
        if length is None:
            raise ApiError(411, "length_required")
        if length > self.cfg.max_upload_bytes:
            raise ApiError(413, "too_large", limit=self.cfg.max_upload_bytes)

        transfer = await self._open_transfer(
            s, {"action": "upload", "dir": directory, "name": name, "size": length, "overwrite": overwrite}
        )
        received = 0
        try:
            try:
                while received < length:
                    chunk = await request.content.read(min(IO_CHUNK, length - received))
                    if not chunk:
                        break
                    received += len(chunk)
                    await write_all(transfer.fd, chunk)
                    s.last_active = time.monotonic()
            except BrokenPipeError:
                # The worker refused the upload before reading everything
                # (e.g. the file exists); drain the body so the browser gets
                # a clean response.
                while await request.content.read(IO_CHUNK):
                    pass
            final = await transfer.finish()
        except BaseException:
            transfer.abort()
            raise
        result = final.get("result") or {}
        if final.get("ok") and result.get("ok"):
            log.info("upload; user=%s path=%s size=%d", s.user, result.get("path"), length)
            return web.json_response({"ok": True, "path": result.get("path"), "size": result.get("size")})
        raise self._file_error(result.get("error") or ("incomplete" if received < length else None))

    async def _stat(self, s: AuthSession, path: str, action: str) -> tuple[FileTransfer, dict, bytes]:
        transfer = await self._open_transfer(s, {"action": action, "path": path})
        try:
            header, rest = await read_header(transfer.fd)
        except (HelperError, ValueError, OSError):
            transfer.abort()
            raise ApiError(500, "io_error") from None
        except BaseException:
            transfer.abort()
            raise
        if not header.get("ok"):
            transfer.abort()
            raise self._file_error(header.get("error"))
        return transfer, header, rest

    async def api_stat(self, request: web.Request) -> web.Response:
        s = self.require_session(request, csrf=False)
        path = request.query.get("path", "")
        if not path:
            raise ApiError(400, "invalid_path")
        transfer, header, _ = await self._stat(s, path, "stat")
        transfer.abort()
        return web.json_response({"ok": True, "name": header.get("name"), "size": header.get("size")})

    async def api_download(self, request: web.Request) -> web.StreamResponse:
        s = self.require_session(request, csrf=False)
        path = request.query.get("path", "")
        if not path:
            raise ApiError(400, "invalid_path")
        transfer, header, rest = await self._stat(s, path, "download")
        size = int(header.get("size") or 0)
        name = str(header.get("name") or "download")
        response = web.StreamResponse(
            headers={
                "Content-Type": "application/octet-stream",
                "Content-Disposition": content_disposition(name),
                "Content-Length": str(size),
            }
        )
        sent = 0
        try:
            await response.prepare(request)
            if rest:
                await response.write(rest)
                sent += len(rest)
            while sent < size:
                chunk = await read_some(transfer.fd, min(IO_CHUNK, size - sent))
                if not chunk:
                    break
                await response.write(chunk)
                sent += len(chunk)
                s.last_active = time.monotonic()
        except BaseException:
            transfer.abort()
            raise
        if sent < size:
            transfer.abort()
            log.warning("download truncated; user=%s path=%s", s.user, path)
            if request.transport is not None:
                request.transport.close()
            return response
        await transfer.finish()
        log.info("download; user=%s path=%s size=%d", s.user, path, size)
        await response.write_eof()
        return response

    # ------------------------------------------------------------ lifecycle
    def sweep(self) -> None:
        now = time.monotonic()
        for s in list(self.sessions.values()):
            if self._expired(s, now):
                self.destroy_session(s, "expired")
                continue
            for tid, term in list(s.terminals.items()):
                if term.sink is not None:
                    continue
                if not term.alive:
                    del s.terminals[tid]
                elif now - term.detached_since > self.cfg.detach_timeout:
                    log.info("closing detached terminal; user=%s pid=%d", s.user, term.pid)
                    term.close()
                    del s.terminals[tid]
        self.limiter.cleanup()

    async def _sweep_loop(self) -> None:
        while True:
            await asyncio.sleep(SWEEP_INTERVAL)
            try:
                self.sweep()
            except Exception:
                log.exception("sweep failed")

    async def on_startup(self, app: web.Application) -> None:
        self._sweeper = asyncio.create_task(self._sweep_loop())

    async def on_shutdown(self, app: web.Application) -> None:
        if self._sweeper:
            self._sweeper.cancel()
        for s in list(self.sessions.values()):
            for term in s.terminals.values():
                if isinstance(term.sink, Attachment):
                    term.sink.kick(1001, "server restarting")
        await asyncio.sleep(0.2)
        for s in list(self.sessions.values()):
            self.destroy_session(s, "server shutdown")
        if self._background:
            await asyncio.wait(list(self._background), timeout=3)


def create_app(config: Config, helper: HelperClient | None = None) -> web.Application:
    state = WebTerm(config, helper or HelperClient(config.helper.socket))
    app = web.Application(middlewares=[state.middleware], client_max_size=64 * 1024)
    app[APP_KEY] = state
    app.on_response_prepare.append(state.on_prepare)
    app.on_startup.append(state.on_startup)
    app.on_shutdown.append(state.on_shutdown)
    r = app.router
    r.add_get("/", state.index)
    r.add_get("/api/session", state.api_session)
    r.add_post("/api/login", state.api_login)
    r.add_post("/api/logout", state.api_logout)
    r.add_post("/api/activity", state.api_activity)
    r.add_get("/api/terminals", state.api_list_terminals)
    r.add_post("/api/terminals", state.api_create_terminal)
    r.add_delete("/api/terminals/{tid}", state.api_close_terminal)
    r.add_get("/ws/terminals/{tid}", state.ws_terminal)
    r.add_post("/api/files/upload", state.api_upload)
    r.add_get("/api/files/stat", state.api_stat)
    r.add_get("/api/files/download", state.api_download)
    r.add_static("/static/", STATIC_DIR, follow_symlinks=False)
    return app


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="WebTerm web server")
    parser.add_argument("--config", default=DEFAULT_CONFIG_PATH)
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.debug else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )
    if os.geteuid() == 0:
        raise SystemExit("refusing to run the web server as root; run it as the 'webterm' user")
    config = load_config(args.config)
    log.info("WebTerm %s listening on %s:%d", __version__, config.web.listen_host, config.web.listen_port)
    web.run_app(
        create_app(config),
        host=config.web.listen_host,
        port=config.web.listen_port,
        access_log=logging.getLogger("webterm.access") if config.web.access_log else None,
        shutdown_timeout=5,
        print=None,
    )


if __name__ == "__main__":
    main()
