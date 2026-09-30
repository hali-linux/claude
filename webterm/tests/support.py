"""Test doubles: a real helper server whose root-only parts are replaced."""

from __future__ import annotations

import os
import threading
import time

from webterm import pam
from webterm.config import Config
from webterm.helper import Grant, Helper, make_server

TEST_USER = "tester"
TEST_PASSWORD = "correct horse battery"


class FakeHelper(Helper):
    """Uses the real socket protocol and fd passing, but no PAM/runuser/setuid.

    Shells run as the current user (``/bin/sh -i``) and file workers run
    without changing credentials, so the tests work without root.
    """

    def __init__(self, config: Config, home: str):
        super().__init__(config)
        self.home = home
        self.allowed_uids = {os.geteuid()}
        self.denial_delay = 0.0

    def policy_denial(self, user):
        return None if user == TEST_USER else "no such user"

    def pam_authenticate(self, user, password, rhost):
        ok = password == TEST_PASSWORD
        return pam.PamResult(ok, pam.PAM_SUCCESS if ok else pam.PAM_AUTH_ERR, "test", user)

    def make_grant(self, user, rhost):
        return Grant(
            user=user,
            uid=os.getuid(),
            gid=os.getgid(),
            home=self.home,
            groups=[],
            rhost=rhost,
            expires=time.monotonic() + self.config.token_lifetime,
        )

    def shell_command(self, grant):
        return [self.setsid, "--ctty", "--wait", "/bin/sh", "-i"]

    def credentials(self, grant):
        return {}


class HelperThread:
    def __init__(self, config: Config, home: str):
        self.helper = FakeHelper(config, home)
        self.server = make_server(config, self.helper)
        self.thread = threading.Thread(target=self.server.serve_forever, args=(0.05,), daemon=True)
        self.thread.start()

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)


def make_config(tmpdir: str) -> Config:
    config = Config()
    config.web.cookie_secure = False
    config.web.login_max_failures = 3
    config.helper.socket = os.path.join(tmpdir, "helper.sock")
    return config
