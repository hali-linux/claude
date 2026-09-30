"""Client used by the (unprivileged) web server to talk to the root helper."""

from __future__ import annotations

import asyncio
import json
import os
import socket
from dataclasses import dataclass, field

MAX_LINE = 64 * 1024


class HelperError(Exception):
    """The helper could not be reached or answered with garbage."""


@dataclass
class HelperReply:
    data: dict
    fd: int | None = None


@dataclass
class _Connection:
    sock: socket.socket
    buffer: bytes = b""
    fds: list = field(default_factory=list)

    def read_line(self) -> dict:
        while b"\n" not in self.buffer:
            data, fds, _flags, _addr = socket.recv_fds(self.sock, MAX_LINE, 4)
            self.fds.extend(fds)
            if not data:
                raise HelperError("helper closed the connection")
            self.buffer += data
            if len(self.buffer) > MAX_LINE:
                raise HelperError("helper reply too large")
        line, self.buffer = self.buffer.split(b"\n", 1)
        try:
            reply = json.loads(line)
        except ValueError as exc:
            raise HelperError("invalid helper reply") from exc
        if not isinstance(reply, dict):
            raise HelperError("invalid helper reply")
        return reply

    def take_fd(self) -> int | None:
        fd = self.fds.pop(0) if self.fds else None
        for extra in self.fds:
            os.close(extra)
        self.fds.clear()
        if fd is not None:
            os.set_inheritable(fd, False)
        return fd

    def close(self) -> None:
        for extra in self.fds:
            os.close(extra)
        self.fds.clear()
        self.sock.close()


class FileTransfer:
    """An in-progress upload/download: a pipe fd plus the helper connection."""

    def __init__(self, conn: _Connection, fd: int):
        self._conn = conn
        self.fd = fd

    def close_pipe(self) -> None:
        if self.fd >= 0:
            os.close(self.fd)
            self.fd = -1

    async def finish(self) -> dict:
        """Close our end of the pipe and wait for the worker's exit status."""
        self.close_pipe()
        try:
            return await asyncio.get_running_loop().run_in_executor(None, self._conn.read_line)
        finally:
            self._conn.close()

    def abort(self) -> None:
        self.close_pipe()
        self._conn.close()


class HelperClient:
    def __init__(self, path: str, timeout: float = 60.0):
        self.path = path
        self.timeout = timeout

    def _open(self, request: dict) -> tuple[_Connection, dict]:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        conn = _Connection(sock)
        try:
            sock.settimeout(self.timeout)
            sock.connect(self.path)
            sock.sendall(json.dumps(request).encode() + b"\n")
            reply = conn.read_line()
        except OSError as exc:
            conn.close()
            raise HelperError(f"helper unavailable: {exc}") from exc
        except HelperError:
            conn.close()
            raise
        return conn, reply

    def _call(self, request: dict) -> HelperReply:
        conn, reply = self._open(request)
        try:
            return HelperReply(reply, conn.take_fd())
        finally:
            conn.close()

    async def call(self, request: dict) -> HelperReply:
        return await asyncio.get_running_loop().run_in_executor(None, self._call, request)

    async def open_transfer(self, request: dict) -> tuple[dict, FileTransfer | None]:
        """Start a file operation.  Returns (first reply, transfer or None)."""

        def start():
            conn, reply = self._open(request)
            fd = conn.take_fd()
            if not reply.get("ok") or fd is None:
                if fd is not None:
                    os.close(fd)
                conn.close()
                return reply, None
            # Streaming may legitimately take a long time.
            conn.sock.settimeout(None)
            return reply, FileTransfer(conn, fd)

        return await asyncio.get_running_loop().run_in_executor(None, start)
