"""File transfer worker.  Executed by the helper *as the logged-in user*.

Running as the user (instead of letting root write files and chown them)
means the kernel enforces the user's own permissions, and symlink tricks
cannot be used to touch files the user could not touch from the shell.

Usage (stdlib only, started with ``python3 -I -S fileops.py ...``):

    fileops.py upload <directory> <name> <size> <overwrite 0|1>
        Reads exactly <size> bytes from stdin and stores them as
        <directory>/<name>.  Prints one JSON result line on stdout.

    fileops.py download <path>
    fileops.py stat <path>
        Prints one JSON header line on stdout ({"ok": true, "name", "size"}
        or {"ok": false, "error"}).  ``download`` then streams exactly
        <size> bytes of file content after the header.

Paths starting with ``~`` are relative to $HOME; other relative paths are
relative to the working directory (the helper starts us in $HOME).
"""

import errno
import json
import os
import stat
import sys

CHUNK = 1 << 20

_ERRNO_CODES = {
    errno.ENOENT: "not_found",
    errno.EACCES: "permission_denied",
    errno.EPERM: "permission_denied",
    errno.ENOTDIR: "not_a_directory",
    errno.EISDIR: "is_a_directory",
    errno.ENOSPC: "no_space",
    errno.EDQUOT: "no_space",
    errno.EEXIST: "exists",
    errno.ENAMETOOLONG: "name_too_long",
    errno.EROFS: "read_only",
    errno.ELOOP: "too_many_links",
}


class Failure(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def _code(exc):
    return _ERRNO_CODES.get(exc.errno, "io_error")


def _write_all(fd, data):
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        view = view[written:]


def _emit(obj):
    _write_all(1, (json.dumps(obj) + "\n").encode())


def expand(path):
    if not path or "\0" in path:
        raise Failure("invalid_path")
    if path == "~" or path.startswith("~/"):
        return os.path.join(os.environ["HOME"], path[2:])
    if path.startswith("~"):
        # ~otheruser is not supported on purpose.
        raise Failure("invalid_path")
    return path


def validate_name(name):
    if (
        not name
        or name in (".", "..")
        or "/" in name
        or "\0" in name
        or len(name.encode("utf-8", "surrogateescape")) > 255
    ):
        raise Failure("invalid_name")


def _temp_name(directory, name):
    base = name if len(name) <= 180 else name[:180]
    return os.path.join(directory, ".%s.webterm-upload-%d" % (base, os.getpid()))


def upload(directory, name, size, overwrite):
    validate_name(name)
    directory = expand(directory)
    try:
        if not stat.S_ISDIR(os.stat(directory).st_mode):
            raise Failure("not_a_directory")
        target = os.path.join(directory, name)
        if os.path.lexists(target):
            if not overwrite:
                raise Failure("exists")
            if os.path.isdir(target):
                raise Failure("is_a_directory")
        tmp = _temp_name(directory, name)
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o666)
    except OSError as exc:
        raise Failure(_code(exc)) from None

    committed = False
    try:
        remaining = size
        while remaining:
            chunk = os.read(0, min(CHUNK, remaining))
            if not chunk:
                # The web server closed the pipe early: the browser aborted.
                raise Failure("incomplete")
            _write_all(fd, chunk)
            remaining -= len(chunk)
        os.fsync(fd)
        os.close(fd)
        fd = -1

        if overwrite:
            try:
                os.chmod(tmp, stat.S_IMODE(os.stat(target).st_mode))
            except FileNotFoundError:
                pass
            os.replace(tmp, target)
        else:
            # link() fails atomically if the target appeared meanwhile.
            try:
                os.link(tmp, target)
            except FileExistsError:
                raise Failure("exists") from None
            except OSError as exc:
                if exc.errno not in (errno.EPERM, errno.EOPNOTSUPP, errno.EXDEV, errno.EMLINK):
                    raise
                if os.path.lexists(target):
                    raise Failure("exists") from None
                os.rename(tmp, target)
            else:
                os.unlink(tmp)
        committed = True
    except OSError as exc:
        raise Failure(_code(exc)) from None
    finally:
        if fd >= 0:
            os.close(fd)
        if not committed:
            try:
                os.unlink(tmp)
            except OSError:
                pass
    _emit({"ok": True, "path": os.path.abspath(target), "size": size})


def download(path, send_data):
    path = expand(path)
    try:
        # O_NONBLOCK so that opening a FIFO does not hang.
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
    except OSError as exc:
        raise Failure(_code(exc)) from None
    try:
        st = os.fstat(fd)
        if stat.S_ISDIR(st.st_mode):
            raise Failure("is_a_directory")
        if not stat.S_ISREG(st.st_mode):
            raise Failure("not_a_regular_file")
        os.set_blocking(fd, True)
        name = os.path.basename(os.path.normpath(path))
        _emit({"ok": True, "name": name, "size": st.st_size})
        if not send_data:
            return
        remaining = st.st_size
        offset = 0
        while remaining:
            sent = os.sendfile(1, fd, offset, min(CHUNK, remaining))
            if sent == 0:
                # The file shrank while we were sending it.
                sys.exit(3)
            offset += sent
            remaining -= sent
    finally:
        os.close(fd)


def main(argv):
    try:
        if len(argv) == 5 and argv[0] == "upload":
            size = int(argv[3])
            if size < 0:
                raise Failure("invalid_size")
            upload(argv[1], argv[2], size, argv[4] == "1")
        elif len(argv) == 2 and argv[0] in ("download", "stat"):
            download(argv[1], argv[0] == "download")
        else:
            _emit({"ok": False, "error": "usage"})
            return 2
    except Failure as exc:
        try:
            _emit({"ok": False, "error": exc.code})
        except OSError:
            pass
        return 1
    except (BrokenPipeError, ConnectionResetError):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
