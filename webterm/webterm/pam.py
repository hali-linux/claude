"""Minimal ctypes binding to Linux-PAM (authentication + account checks only).

Only the helper (running as root) uses this module: pam_unix can verify the
password of arbitrary users only when the caller is root.
"""

from __future__ import annotations

import ctypes
import ctypes.util
from ctypes import (
    CFUNCTYPE,
    POINTER,
    Structure,
    c_char_p,
    c_int,
    c_size_t,
    c_void_p,
    cast,
    sizeof,
)
from dataclasses import dataclass, field

PAM_SUCCESS = 0
PAM_BUF_ERR = 5
PAM_CONV_ERR = 19
PAM_NEW_AUTHTOK_REQD = 12
PAM_ACCT_EXPIRED = 13
PAM_USER_UNKNOWN = 10
PAM_MAXTRIES = 11
PAM_AUTH_ERR = 7
PAM_PERM_DENIED = 6

PAM_PROMPT_ECHO_OFF = 1
PAM_PROMPT_ECHO_ON = 2
PAM_ERROR_MSG = 3
PAM_TEXT_INFO = 4

PAM_USER = 2
PAM_TTY = 3
PAM_RHOST = 4
PAM_RUSER = 8

PAM_DISALLOW_NULL_AUTHTOK = 0x0001


class _PamHandle(Structure):
    _fields_ = [("handle", c_void_p)]


class _PamMessage(Structure):
    _fields_ = [("msg_style", c_int), ("msg", c_char_p)]


class _PamResponse(Structure):
    # ``resp`` must point to malloc()ed memory: PAM frees it.
    _fields_ = [("resp", c_void_p), ("resp_retcode", c_int)]


_CONV_FUNC = CFUNCTYPE(
    c_int,
    c_int,
    POINTER(POINTER(_PamMessage)),
    POINTER(POINTER(_PamResponse)),
    c_void_p,
)


class _PamConv(Structure):
    _fields_ = [("conv", _CONV_FUNC), ("appdata_ptr", c_void_p)]


_libs: tuple | None = None


def _load() -> tuple:
    global _libs
    if _libs is None:
        libc = ctypes.CDLL(ctypes.util.find_library("c") or "libc.so.6")
        libc.calloc.restype = c_void_p
        libc.calloc.argtypes = [c_size_t, c_size_t]
        libc.strdup.restype = c_void_p
        libc.strdup.argtypes = [c_char_p]

        libpam = ctypes.CDLL(ctypes.util.find_library("pam") or "libpam.so.0")
        libpam.pam_start.restype = c_int
        libpam.pam_start.argtypes = [c_char_p, c_char_p, POINTER(_PamConv), POINTER(_PamHandle)]
        libpam.pam_end.restype = c_int
        libpam.pam_end.argtypes = [_PamHandle, c_int]
        libpam.pam_authenticate.restype = c_int
        libpam.pam_authenticate.argtypes = [_PamHandle, c_int]
        libpam.pam_acct_mgmt.restype = c_int
        libpam.pam_acct_mgmt.argtypes = [_PamHandle, c_int]
        libpam.pam_set_item.restype = c_int
        libpam.pam_set_item.argtypes = [_PamHandle, c_int, c_void_p]
        libpam.pam_get_item.restype = c_int
        libpam.pam_get_item.argtypes = [_PamHandle, c_int, POINTER(c_void_p)]
        libpam.pam_strerror.restype = c_char_p
        libpam.pam_strerror.argtypes = [_PamHandle, c_int]
        _libs = (libc, libpam)
    return _libs


@dataclass
class PamResult:
    ok: bool
    code: int
    reason: str
    # Username after PAM processing (modules may canonicalise it).
    user: str
    messages: list = field(default_factory=list)


def authenticate(
    service: str,
    username: str,
    password: str,
    *,
    rhost: str = "",
    tty: str = "webterm",
) -> PamResult:
    """Run pam_authenticate + pam_acct_mgmt for ``username``.

    Blocking (PAM modules sleep on failures); call from a worker thread.
    """
    libc, libpam = _load()
    user_b = username.encode()
    password_b = password.encode()
    messages: list[str] = []

    @_CONV_FUNC
    def conversation(n_messages, msgs, p_response, _appdata):
        addr = libc.calloc(n_messages, sizeof(_PamResponse))
        if not addr:
            return PAM_BUF_ERR
        responses = cast(addr, POINTER(_PamResponse))
        for i in range(n_messages):
            message = msgs[i].contents
            style = message.msg_style
            text = (message.msg or b"").decode(errors="replace")
            if style == PAM_PROMPT_ECHO_OFF:
                responses[i].resp = libc.strdup(password_b)
            elif style == PAM_PROMPT_ECHO_ON:
                # Some modules ask for the login name again.
                responses[i].resp = libc.strdup(user_b)
            elif style in (PAM_ERROR_MSG, PAM_TEXT_INFO):
                messages.append(text)
        p_response[0] = responses
        return PAM_SUCCESS

    conv = _PamConv(conversation, None)
    handle = _PamHandle()
    rc = libpam.pam_start(service.encode(), user_b, ctypes.byref(conv), ctypes.byref(handle))
    if rc != PAM_SUCCESS:
        return PamResult(False, rc, f"pam_start failed ({rc})", username, messages)

    def strerror(code: int) -> str:
        text = libpam.pam_strerror(handle, code)
        return text.decode(errors="replace") if text else str(code)

    final_user = username
    try:
        if rhost:
            rhost_b = ctypes.create_string_buffer(rhost.encode())
            libpam.pam_set_item(handle, PAM_RHOST, cast(rhost_b, c_void_p))
        tty_b = ctypes.create_string_buffer(tty.encode())
        libpam.pam_set_item(handle, PAM_TTY, cast(tty_b, c_void_p))

        rc = libpam.pam_authenticate(handle, PAM_DISALLOW_NULL_AUTHTOK)
        if rc != PAM_SUCCESS:
            return PamResult(False, rc, strerror(rc), username, messages)

        rc = libpam.pam_acct_mgmt(handle, PAM_DISALLOW_NULL_AUTHTOK)
        if rc != PAM_SUCCESS:
            return PamResult(False, rc, strerror(rc), username, messages)

        item = c_void_p()
        if libpam.pam_get_item(handle, PAM_USER, ctypes.byref(item)) == PAM_SUCCESS and item.value:
            final_user = ctypes.string_at(item.value).decode(errors="replace")
        return PamResult(True, rc, "success", final_user, messages)
    finally:
        libpam.pam_end(handle, rc)
