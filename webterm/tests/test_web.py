"""End-to-end tests of the web server against a real helper socket."""

import asyncio
import json
import os
import tempfile
import time
import unittest

from aiohttp import WSMsgType
from aiohttp.test_utils import TestClient, TestServer

from tests.support import TEST_PASSWORD, TEST_USER, HelperThread, make_config
from webterm.web import APP_KEY, create_app


class WebTestCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = os.path.join(self.tmp.name, "home")
        os.mkdir(self.home)
        self.config = make_config(self.tmp.name)
        self.configure(self.config)
        self.helper = HelperThread(self.config, self.home)
        self.app = create_app(self.config)
        self.state = self.app[APP_KEY]
        self.client = TestClient(TestServer(self.app))
        await self.client.start_server()
        self.origin = f"http://{self.client.host}:{self.client.port}"
        self.csrf = None

    def configure(self, config):
        pass

    async def asyncTearDown(self):
        await self.client.close()
        self.helper.stop()
        self.tmp.cleanup()

    # helpers -----------------------------------------------------------
    def headers(self, csrf=True):
        headers = {"Origin": self.origin}
        if csrf and self.csrf:
            headers["X-CSRF-Token"] = self.csrf
        return headers

    async def login(self, password=TEST_PASSWORD, user=TEST_USER):
        resp = await self.client.post(
            "/api/login", json={"username": user, "password": password}, headers=self.headers(False)
        )
        if resp.status == 200:
            info = await (await self.client.get("/api/session")).json()
            self.csrf = info["csrf"]
        return resp

    async def new_terminal(self):
        resp = await self.client.post("/api/terminals", json={"cols": 100, "rows": 30}, headers=self.headers())
        self.assertEqual(resp.status, 201, await resp.text())
        return (await resp.json())["id"]

    async def connect(self, tid, offset=None):
        url = f"/ws/terminals/{tid}"
        if offset is not None:
            url += f"?offset={offset}"
        return await self.client.ws_connect(url, headers={"Origin": self.origin})


class Reader:
    """Collects terminal output and control messages from a WebSocket."""

    def __init__(self, ws):
        self.ws = ws
        self.data = bytearray()
        self.control = []
        self.closed = None

    async def until(self, predicate, timeout=5):
        async def loop():
            while not predicate(self):
                msg = await self.ws.receive()
                if msg.type == WSMsgType.BINARY:
                    self.data += msg.data
                elif msg.type == WSMsgType.TEXT:
                    self.control.append(json.loads(msg.data))
                elif msg.type in (WSMsgType.CLOSE, WSMsgType.CLOSED, WSMsgType.CLOSING):
                    self.closed = self.ws.close_code
                    return

        await asyncio.wait_for(loop(), timeout)
        return self

    async def output(self, needle, timeout=5):
        await self.until(lambda r: needle in r.data or r.closed is not None, timeout)
        if needle not in self.data:
            raise AssertionError(f"{needle!r} not in output: {bytes(self.data)!r}")

    async def closure(self, timeout=5):
        await self.until(lambda r: r.closed is not None, timeout)
        return self.closed


class AuthTests(WebTestCase):
    async def test_index_and_security_headers(self):
        resp = await self.client.get("/")
        self.assertEqual(resp.status, 200)
        body = await resp.text()
        self.assertIn("<title>WebTerm</title>", body)
        self.assertIn("static/app.js?v=", body)
        csp = resp.headers["Content-Security-Policy"]
        self.assertIn("script-src 'self'", csp)
        self.assertIn("frame-ancestors 'none'", csp)
        self.assertEqual(resp.headers["X-Frame-Options"], "DENY")
        static = await self.client.get("/static/app.js")
        self.assertEqual(static.status, 200)
        self.assertIn("max-age", static.headers["Cache-Control"])

    async def test_session_requires_login(self):
        info = await (await self.client.get("/api/session")).json()
        self.assertFalse(info["authenticated"])
        self.assertNotIn("csrf", info)
        resp = await self.client.get("/api/terminals")
        self.assertEqual(resp.status, 401)

    async def test_login_requires_same_origin(self):
        resp = await self.client.post("/api/login", json={"username": TEST_USER, "password": TEST_PASSWORD})
        self.assertEqual(resp.status, 403)
        resp = await self.client.post(
            "/api/login",
            json={"username": TEST_USER, "password": TEST_PASSWORD},
            headers={"Origin": "https://evil.example"},
        )
        self.assertEqual(resp.status, 403)

    async def test_cross_site_fetch_metadata_rejected(self):
        resp = await self.client.get("/api/session", headers={"Sec-Fetch-Site": "cross-site"})
        self.assertEqual(resp.status, 403)

    async def test_login_success_sets_hardened_cookie(self):
        resp = await self.login()
        self.assertEqual(resp.status, 200)
        cookie = resp.headers["Set-Cookie"]
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=Strict", cookie)
        info = await (await self.client.get("/api/session")).json()
        self.assertTrue(info["authenticated"])
        self.assertEqual(info["user"], TEST_USER)
        self.assertEqual(info["home"], self.home)

    async def test_wrong_password_and_lockout(self):
        for _ in range(3):
            resp = await self.login(password="nope")
            self.assertEqual(resp.status, 401)
            self.assertEqual((await resp.json())["error"], "auth_failed")
        resp = await self.login()  # correct password, but locked out now
        self.assertEqual(resp.status, 429)
        self.assertGreater((await resp.json())["retryAfter"], 0)

    async def test_unknown_user_looks_like_wrong_password(self):
        resp = await self.login(user="nobody")
        self.assertEqual(resp.status, 401)
        self.assertEqual((await resp.json())["error"], "auth_failed")

    async def test_csrf_token_required(self):
        await self.login()
        resp = await self.client.post("/api/terminals", json={}, headers={"Origin": self.origin})
        self.assertEqual(resp.status, 403)
        resp = await self.client.post(
            "/api/terminals", json={}, headers={"Origin": self.origin, "X-CSRF-Token": "wrong"}
        )
        self.assertEqual(resp.status, 403)

    async def test_logout_closes_terminals(self):
        await self.login()
        tid = await self.new_terminal()
        reader = Reader(await self.connect(tid))
        await reader.until(lambda r: r.control)
        resp = await self.client.post("/api/logout", json={}, headers=self.headers())
        self.assertEqual(resp.status, 200)
        self.assertEqual(await reader.closure(), 4001)
        info = await (await self.client.get("/api/session")).json()
        self.assertFalse(info["authenticated"])
        # The helper token was revoked as well.
        for _ in range(50):
            if not self.helper.helper.grants:
                break
            await asyncio.sleep(0.02)
        self.assertEqual(self.helper.helper.grants, {})

    async def test_websocket_without_session(self):
        ws = await self.client.ws_connect("/ws/terminals/whatever", headers={"Origin": self.origin})
        self.assertEqual(await Reader(ws).closure(), 4001)

    async def test_websocket_requires_origin(self):
        await self.login()
        tid = await self.new_terminal()
        resp = await self.client.get(
            f"/ws/terminals/{tid}",
            headers={"Origin": "https://evil.example", "Connection": "Upgrade", "Upgrade": "websocket",
                     "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ=="},
        )
        self.assertEqual(resp.status, 403)


class TerminalTests(WebTestCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.assertEqual((await self.login()).status, 200)

    async def test_shell_round_trip(self):
        tid = await self.new_terminal()
        reader = Reader(await self.connect(tid))
        await reader.until(lambda r: r.control)
        hello = reader.control[0]
        self.assertEqual(hello["t"], "hello")
        self.assertEqual(hello["id"], tid)
        await reader.ws.send_bytes(b"echo mar''ker-$((6*7))\n")
        await reader.output(b"marker-42")

        await reader.ws.send_str(json.dumps({"t": "resize", "cols": 120, "rows": 40}))
        await reader.ws.send_bytes(b"stty size\n")
        await reader.output(b"40 120")

        await reader.ws.send_str(json.dumps({"t": "ping"}))
        await reader.until(lambda r: any(m["t"] == "pong" for m in r.control))
        await reader.ws.close()

    async def test_reattach_replays_only_missing_output(self):
        tid = await self.new_terminal()
        first = Reader(await self.connect(tid))
        await first.ws.send_bytes(b"echo fir''st\n")
        await first.output(b"first")
        seen = len(first.data)
        await first.ws.close()

        # Output produced while no browser is attached is kept.
        await asyncio.sleep(0.1)
        terms = (await (await self.client.get("/api/terminals")).json())["terminals"]
        self.assertEqual([t["id"] for t in terms], [tid])
        self.assertFalse(terms[0]["attached"])

        second = Reader(await self.connect(tid, offset=seen))
        await second.until(lambda r: r.control)
        self.assertFalse(second.control[0]["reset"])
        self.assertEqual(second.control[0]["offset"], seen)
        await second.ws.send_bytes(b"echo sec''ond\n")
        await second.output(b"second")
        self.assertNotIn(b"first", second.data)
        await second.ws.close()

        third = Reader(await self.connect(tid))  # fresh page: full replay
        await third.until(lambda r: r.control)
        self.assertTrue(third.control[0]["reset"])
        await third.output(b"second")
        self.assertIn(b"first", third.data)
        await third.ws.close()

    async def test_second_attachment_replaces_first(self):
        tid = await self.new_terminal()
        first = Reader(await self.connect(tid))
        await first.until(lambda r: r.control)
        second = Reader(await self.connect(tid))
        self.assertEqual(await first.closure(), 4000)
        await second.ws.send_bytes(b"echo st''ill-alive\n")
        await second.output(b"still-alive")
        await second.ws.close()

    async def test_exit_and_close(self):
        tid = await self.new_terminal()
        reader = Reader(await self.connect(tid))
        await reader.ws.send_bytes(b"exit\n")
        self.assertEqual(await reader.closure(), 1000)
        self.assertIn({"t": "exit"}, reader.control)
        again = Reader(await self.connect(tid))
        self.assertEqual(await again.closure(), 4004)

        tid = await self.new_terminal()
        reader = Reader(await self.connect(tid))
        await reader.until(lambda r: r.control)
        resp = await self.client.delete(f"/api/terminals/{tid}", headers=self.headers())
        self.assertEqual(resp.status, 200)
        self.assertEqual(await reader.closure(), 4004)

    async def test_terminal_limit(self):
        self.state.cfg.max_terminals = 2
        await self.new_terminal()
        await self.new_terminal()
        resp = await self.client.post("/api/terminals", json={}, headers=self.headers())
        self.assertEqual(resp.status, 409)
        self.assertEqual((await resp.json())["limit"], 2)

    async def test_idle_timeout_ends_session(self):
        tid = await self.new_terminal()
        reader = Reader(await self.connect(tid))
        await reader.until(lambda r: r.control)
        session = next(iter(self.state.sessions.values()))
        session.last_active -= self.state.cfg.session_idle_timeout + 1
        self.state.sweep()
        self.assertEqual(await reader.closure(), 4001)
        self.assertEqual((await self.client.get("/api/terminals")).status, 401)

    async def test_detached_terminal_times_out(self):
        tid = await self.new_terminal()
        session = next(iter(self.state.sessions.values()))
        term = session.terminals[tid]
        term.detached_since = time.monotonic() - self.state.cfg.detach_timeout - 1
        self.state.sweep()
        self.assertNotIn(tid, session.terminals)
        self.assertFalse(term.alive)


class FileTests(WebTestCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.assertEqual((await self.login()).status, 200)

    async def upload(self, name, data, directory="~", overwrite=False):
        return await self.client.post(
            "/api/files/upload",
            params={"dir": directory, "name": name, "overwrite": "1" if overwrite else "0"},
            data=data,
            headers={**self.headers(), "Content-Type": "application/octet-stream"},
        )

    async def test_upload_download_round_trip(self):
        payload = os.urandom(700_000)
        resp = await self.upload("데이터.bin", payload)
        self.assertEqual(resp.status, 200, await resp.text())
        result = await resp.json()
        self.assertEqual(result["path"], os.path.join(self.home, "데이터.bin"))
        with open(result["path"], "rb") as fh:
            self.assertEqual(fh.read(), payload)

        resp = await self.client.get("/api/files/stat", params={"path": "~/데이터.bin"})
        self.assertEqual(await resp.json(), {"ok": True, "name": "데이터.bin", "size": len(payload)})

        resp = await self.client.get("/api/files/download", params={"path": "~/데이터.bin"})
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.headers["Content-Length"], str(len(payload)))
        self.assertIn("filename*=UTF-8''%EB%8D%B0", resp.headers["Content-Disposition"])
        self.assertEqual(await resp.read(), payload)

    async def test_upload_conflict_and_overwrite(self):
        self.assertEqual((await self.upload("a.txt", b"one")).status, 200)
        resp = await self.upload("a.txt", b"two" * 100_000)
        self.assertEqual(resp.status, 409)
        self.assertEqual((await resp.json())["error"], "exists")
        resp = await self.upload("a.txt", b"three", overwrite=True)
        self.assertEqual(resp.status, 200)
        with open(os.path.join(self.home, "a.txt"), "rb") as fh:
            self.assertEqual(fh.read(), b"three")

    async def test_upload_limits_and_validation(self):
        self.state.cfg.max_upload_bytes = 10
        resp = await self.upload("big.bin", b"x" * 11)
        self.assertEqual(resp.status, 413)
        resp = await self.upload("../escape", b"x")
        self.assertEqual(resp.status, 400)
        resp = await self.upload("x", b"x", directory="~/missing")
        self.assertEqual((resp.status, (await resp.json())["error"]), (404, "not_found"))
        resp = await self.client.post(
            "/api/files/upload", params={"name": "x"}, data=b"x", headers={"Origin": self.origin}
        )
        self.assertEqual(resp.status, 403)  # no CSRF token

    async def test_download_errors(self):
        os.mkdir(os.path.join(self.home, "dir"))
        resp = await self.client.get("/api/files/download", params={"path": "~/missing"})
        self.assertEqual((resp.status, (await resp.json())["error"]), (404, "not_found"))
        resp = await self.client.get("/api/files/stat", params={"path": "~/dir"})
        self.assertEqual((resp.status, (await resp.json())["error"]), (400, "is_a_directory"))


if __name__ == "__main__":
    unittest.main()
