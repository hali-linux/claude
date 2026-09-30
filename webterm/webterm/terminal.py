"""PTY-backed terminals living inside the web server process.

The web server only holds the PTY *master* (received from the helper).
Output is read continuously - also while no browser is attached - into a
bounded scrollback buffer so that a browser can re-attach after a reload or
a network interruption and continue exactly where it left off.
"""

from __future__ import annotations

import asyncio
import errno
import fcntl
import os
import secrets
import struct
import termios
import time
from typing import Protocol

READ_SIZE = 64 * 1024
MAX_PENDING_INPUT = 4 * 1024 * 1024


class Sink(Protocol):
    """Receiver of terminal output (a WebSocket attachment)."""

    def feed(self, data: bytes) -> None: ...

    def terminal_exited(self) -> None: ...


class Terminal:
    def __init__(self, master_fd: int, *, owner: str, scrollback_limit: int, pid: int = 0,
                 cols: int = 80, rows: int = 24):
        self.id = secrets.token_urlsafe(12)
        self.owner = owner
        self.pid = pid
        self.fd = master_fd
        self.cols = cols
        self.rows = rows
        self.created = time.time()
        self.alive = True
        self.sink: Sink | None = None
        self.detached_since = time.monotonic()
        self._limit = scrollback_limit
        self._scrollback = bytearray()
        # Total number of output bytes ever produced; the scrollback holds
        # the range [total_out - len(scrollback), total_out).
        self.total_out = 0
        self._pending = bytearray()
        self._reading = False
        self._writing = False
        self._paused = False
        self._loop = asyncio.get_running_loop()
        os.set_blocking(master_fd, False)
        self._set_reading(True)

    # ------------------------------------------------------------------ output
    def _set_reading(self, enabled: bool) -> None:
        if not self.alive or enabled == self._reading:
            return
        if enabled:
            self._loop.add_reader(self.fd, self._on_readable)
        else:
            self._loop.remove_reader(self.fd)
        self._reading = enabled

    def _on_readable(self) -> None:
        try:
            data = os.read(self.fd, READ_SIZE)
        except BlockingIOError:
            return
        except OSError as exc:
            # EIO: every process on the slave side has exited.
            if exc.errno not in (errno.EIO, errno.EBADF):
                raise
            data = b""
        if not data:
            self._exited()
            return
        self.total_out += len(data)
        self._scrollback += data
        overflow = len(self._scrollback) - self._limit
        if overflow > 0:
            del self._scrollback[:overflow]
        if self.sink is not None:
            self.sink.feed(data)

    def pause(self) -> None:
        """Stop reading (back-pressure from a slow browser)."""
        self._paused = True
        self._set_reading(False)

    def resume(self) -> None:
        self._paused = False
        self._set_reading(True)

    def _exited(self) -> None:
        sink = self.sink
        self.close()
        if sink is not None:
            sink.terminal_exited()

    # ---------------------------------------------------------------- attaching
    def attach(self, sink: Sink, offset: int | None) -> tuple[int, bytes, bool]:
        """Attach ``sink`` and return (start offset, replay data, reset flag).

        If the browser already has output up to ``offset`` and that position
        is still in the scrollback, only the missing part is replayed.
        Otherwise the whole scrollback is replayed and the browser must reset
        its screen first.
        """
        start = self.total_out - len(self._scrollback)
        self.sink = sink
        self.resume()
        if offset is not None and start <= offset <= self.total_out:
            return offset, bytes(self._scrollback[offset - start:]), False
        return start, bytes(self._scrollback), True

    def detach(self, sink: Sink) -> None:
        if self.sink is sink:
            self.sink = None
            self.detached_since = time.monotonic()
            if self._paused:
                self.resume()

    # ------------------------------------------------------------------- input
    def write(self, data: bytes) -> None:
        if not self.alive or not data:
            return
        if len(self._pending) + len(data) > MAX_PENDING_INPUT:
            return  # the shell is not reading; drop instead of growing forever
        self._pending += data
        self._flush()

    def _flush(self) -> None:
        while self._pending and self.alive:
            try:
                written = os.write(self.fd, self._pending)
            except BlockingIOError:
                break
            except OSError:
                self._pending.clear()
                break
            del self._pending[:written]
        want = bool(self._pending) and self.alive
        if want != self._writing:
            if want:
                self._loop.add_writer(self.fd, self._flush)
            else:
                self._loop.remove_writer(self.fd)
            self._writing = want

    def resize(self, cols: int, rows: int) -> None:
        if not self.alive:
            return
        cols = max(10, min(1000, cols))
        rows = max(5, min(500, rows))
        self.cols, self.rows = cols, rows
        try:
            fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        except OSError:
            pass

    # ------------------------------------------------------------------- close
    def close(self) -> None:
        """Close the master side; the kernel sends SIGHUP to the shell."""
        if not self.alive:
            return
        self._set_reading(False)
        if self._writing:
            self._loop.remove_writer(self.fd)
            self._writing = False
        self.alive = False
        try:
            os.close(self.fd)
        except OSError:
            pass
        self.fd = -1

    def info(self) -> dict:
        return {
            "id": self.id,
            "created": int(self.created),
            "cols": self.cols,
            "rows": self.rows,
            "attached": self.sink is not None,
            "alive": self.alive,
        }
