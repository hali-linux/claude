import json
import os
import subprocess
import sys
import tempfile
import unittest

from webterm.helper import FILEOPS


class FileOpsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = self.tmp.name
        self.addCleanup(self.tmp.cleanup)

    def run_op(self, *args, data=b""):
        proc = subprocess.run(
            [sys.executable, "-I", "-S", FILEOPS, *args],
            input=data,
            capture_output=True,
            cwd=self.home,
            env={"HOME": self.home, "PATH": "/usr/bin:/bin"},
            timeout=10,
        )
        header, _, rest = proc.stdout.partition(b"\n")
        return proc.returncode, json.loads(header), rest

    def upload(self, directory, name, data, overwrite=False, size=None):
        size = len(data) if size is None else size
        return self.run_op("upload", directory, name, str(size), "1" if overwrite else "0", data=data)

    def test_upload_to_home(self):
        code, result, _ = self.upload("~", "hello.txt", b"hello world")
        self.assertEqual(code, 0)
        self.assertEqual(result, {"ok": True, "path": os.path.join(self.home, "hello.txt"), "size": 11})
        with open(os.path.join(self.home, "hello.txt"), "rb") as fh:
            self.assertEqual(fh.read(), b"hello world")
        self.assertEqual([n for n in os.listdir(self.home) if n.startswith(".")], [])

    def test_upload_relative_and_subdirectory(self):
        os.mkdir(os.path.join(self.home, "sub"))
        code, result, _ = self.upload("sub", "a.bin", b"\x00\x01\x02")
        self.assertEqual(code, 0)
        self.assertEqual(result["path"], os.path.join(self.home, "sub", "a.bin"))
        code, result, _ = self.upload("~/sub/", "b.bin", b"x")
        self.assertEqual(code, 0)

    def test_upload_refuses_to_clobber(self):
        self.upload("~", "f.txt", b"one")
        code, result, _ = self.upload("~", "f.txt", b"two")
        self.assertEqual((code, result), (1, {"ok": False, "error": "exists"}))
        with open(os.path.join(self.home, "f.txt"), "rb") as fh:
            self.assertEqual(fh.read(), b"one")

    def test_upload_overwrite_keeps_mode(self):
        path = os.path.join(self.home, "run.sh")
        self.upload("~", "run.sh", b"old")
        os.chmod(path, 0o750)
        code, _, _ = self.upload("~", "run.sh", b"new content", overwrite=True)
        self.assertEqual(code, 0)
        with open(path, "rb") as fh:
            self.assertEqual(fh.read(), b"new content")
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o750)

    def test_incomplete_upload_leaves_nothing(self):
        code, result, _ = self.upload("~", "big.bin", b"short", size=100)
        self.assertEqual((code, result["error"]), (1, "incomplete"))
        self.assertEqual(os.listdir(self.home), [])

    def test_invalid_names_and_paths(self):
        for name in ("", ".", "..", "a/b", "x" * 300):
            code, result, _ = self.upload("~", name, b"")
            self.assertEqual(result["error"], "invalid_name", name)
        code, result, _ = self.upload("~root", "a", b"")
        self.assertEqual(result["error"], "invalid_path")
        code, result, _ = self.upload("~/missing", "a", b"")
        self.assertEqual(result["error"], "not_found")
        open(os.path.join(self.home, "file"), "w").close()
        code, result, _ = self.upload("~/file", "a", b"")
        self.assertEqual(result["error"], "not_a_directory")

    def test_upload_into_unwritable_directory(self):
        if os.geteuid() == 0:
            self.skipTest("root bypasses permission checks")
        locked = os.path.join(self.home, "locked")
        os.mkdir(locked, 0o500)
        code, result, _ = self.upload("~/locked", "a", b"x")
        self.assertEqual(result["error"], "permission_denied")

    def test_download_and_stat(self):
        data = os.urandom(3 * 1024 * 1024 + 17)
        with open(os.path.join(self.home, "blob.bin"), "wb") as fh:
            fh.write(data)
        code, header, rest = self.run_op("download", "~/blob.bin")
        self.assertEqual(code, 0)
        self.assertEqual(header, {"ok": True, "name": "blob.bin", "size": len(data)})
        self.assertEqual(rest, data)
        code, header, rest = self.run_op("stat", "blob.bin")
        self.assertEqual((code, header["size"], rest), (0, len(data), b""))

    def test_download_errors(self):
        os.mkdir(os.path.join(self.home, "dir"))
        os.mkfifo(os.path.join(self.home, "fifo"))
        self.assertEqual(self.run_op("download", "~/nope")[1]["error"], "not_found")
        self.assertEqual(self.run_op("download", "~/dir")[1]["error"], "is_a_directory")
        self.assertEqual(self.run_op("download", "~/fifo")[1]["error"], "not_a_regular_file")
        self.assertEqual(self.run_op("bogus")[1]["error"], "usage")


if __name__ == "__main__":
    unittest.main()
