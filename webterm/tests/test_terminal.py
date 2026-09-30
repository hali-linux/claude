import asyncio
import fcntl
import os
import struct
import termios
import tty
import unittest

from webterm.terminal import Terminal


class RecordingSink:
    def __init__(self):
        self.data = bytearray()
        self.exited = asyncio.Event()
        self.changed = asyncio.Event()

    def feed(self, data):
        self.data += data
        self.changed.set()

    def terminal_exited(self):
        self.exited.set()

    async def wait_for(self, needle, timeout=3):
        async def loop():
            while needle not in self.data:
                self.changed.clear()
                await self.changed.wait()

        await asyncio.wait_for(loop(), timeout)


class TerminalTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        master, self.slave = os.openpty()
        tty.setraw(self.slave)
        self.term = Terminal(master, owner="s", scrollback_limit=4096)

    async def asyncTearDown(self):
        self.term.close()
        try:
            os.close(self.slave)
        except OSError:
            pass

    async def output(self, data):
        os.write(self.slave, data)
        await asyncio.sleep(0.05)

    async def test_scrollback_and_offsets(self):
        await self.output(b"hello ")
        sink = RecordingSink()
        start, replay, reset = self.term.attach(sink, None)
        self.assertEqual((start, replay, reset), (0, b"hello ", True))
        await self.output(b"world")
        await sink.wait_for(b"world")
        self.assertEqual(self.term.total_out, 11)
        self.term.detach(sink)

        await self.output(b"!!")
        # A browser that already has 11 bytes only needs the missing ones.
        start, replay, reset = self.term.attach(RecordingSink(), 11)
        self.assertEqual((start, replay, reset), (11, b"!!", False))

    async def test_scrollback_is_bounded(self):
        for _ in range(3):
            await self.output(b"x" * 3000)
        sink = RecordingSink()
        start, replay, reset = self.term.attach(sink, 5)  # offset no longer available
        self.assertTrue(reset)
        self.assertEqual(len(replay), 4096)
        self.assertEqual(start, self.term.total_out - 4096)

    async def test_input_and_resize(self):
        self.term.write(b"typed")
        await asyncio.sleep(0.05)
        self.assertEqual(os.read(self.slave, 100), b"typed")
        self.term.resize(132, 43)
        rows, cols, _, _ = struct.unpack("HHHH", fcntl.ioctl(self.slave, termios.TIOCGWINSZ, b"\0" * 8))
        self.assertEqual((cols, rows), (132, 43))

    async def test_exit_is_reported(self):
        sink = RecordingSink()
        self.term.attach(sink, None)
        os.close(self.slave)
        await asyncio.wait_for(sink.exited.wait(), 3)
        self.assertFalse(self.term.alive)


if __name__ == "__main__":
    unittest.main()
