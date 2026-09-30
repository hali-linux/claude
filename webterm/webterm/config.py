"""Configuration shared by the web server and the privileged helper.

The configuration is a single INI file (default ``/etc/webterm/webterm.conf``)
with a ``[web]`` section for the unprivileged web server and a ``[helper]``
section for the root helper.  Both processes read the whole file; it must
therefore not contain secrets.
"""

from __future__ import annotations

import configparser
import dataclasses
import logging
from dataclasses import dataclass, field
from typing import Any

DEFAULT_CONFIG_PATH = "/etc/webterm/webterm.conf"

log = logging.getLogger(__name__)


class ConfigError(Exception):
    pass


@dataclass
class WebConfig:
    listen_host: str = "127.0.0.1"
    listen_port: int = 8022
    title: str = "WebTerm"
    # Text shown under the login form (e.g. an "authorized use only" notice).
    login_notice: str = ""
    # Only requests coming from these addresses may set X-Forwarded-For/-Proto.
    trusted_proxies: tuple = ("127.0.0.1", "::1")
    # Allowed values of the Origin header for WebSocket and state changing
    # requests.  Empty = "<scheme>://<Host header>" of the request itself.
    allowed_origins: tuple = ()
    cookie_name: str = "webterm_session"
    cookie_path: str = "/"
    cookie_secure: bool = True
    # Seconds without keyboard/API activity before the login session (and
    # all of its terminals) is closed.  0 disables the idle timeout.
    session_idle_timeout: int = 3600
    # Absolute lifetime of a login session in seconds.
    session_max_lifetime: int = 43200
    # Terminals keep running this many seconds after the browser disconnects
    # so that a reload / network hiccup can re-attach to them.
    detach_timeout: int = 900
    max_terminals: int = 6
    max_sessions_per_user: int = 5
    # Output kept per terminal for re-attaching (bytes).
    scrollback_bytes: int = 262144
    max_upload_bytes: int = 1073741824
    login_max_failures: int = 5
    login_failure_window: int = 600
    login_lockout: int = 900
    access_log: bool = False


@dataclass
class HelperConfig:
    socket: str = "/run/webterm/helper.sock"
    # Group owning the socket; the web server user must be in it.
    socket_group: str = "webterm"
    # Only this user (and root) may talk to the helper (checked by SO_PEERCRED).
    client_user: str = "webterm"
    pam_service: str = "webterm"
    # Users must be a member of at least one of these groups.  Empty = any
    # user with a valid password and a login shell may log in.
    allowed_groups: tuple = ("webterm-users",)
    denied_users: tuple = ("root",)
    allow_root: bool = False
    # Lifetime of the token handed to the web server after a login.
    token_lifetime: int = 43200
    term: str = "xterm-256color"
    # Optional LANG for new shells (the login shell normally sets it from
    # /etc/locale.conf anyway).
    lang: str = ""


@dataclass
class Config:
    web: WebConfig = field(default_factory=WebConfig)
    helper: HelperConfig = field(default_factory=HelperConfig)


def _convert(name: str, raw: str, default: Any) -> Any:
    raw = raw.strip()
    if isinstance(default, bool):
        lowered = raw.lower()
        if lowered in ("1", "yes", "true", "on"):
            return True
        if lowered in ("0", "no", "false", "off"):
            return False
        raise ConfigError(f"{name}: expected a boolean, got {raw!r}")
    if isinstance(default, int):
        try:
            value = int(raw)
        except ValueError:
            raise ConfigError(f"{name}: expected an integer, got {raw!r}") from None
        if value < 0:
            raise ConfigError(f"{name}: must not be negative")
        return value
    if isinstance(default, tuple):
        return tuple(item.strip() for item in raw.replace("\n", ",").split(",") if item.strip())
    return raw


def _load_section(parser: configparser.ConfigParser, section: str, obj: Any) -> None:
    if not parser.has_section(section):
        return
    known = {f.name: f for f in dataclasses.fields(obj)}
    for key, raw in parser.items(section):
        if key not in known:
            log.warning("config: unknown option [%s] %s ignored", section, key)
            continue
        setattr(obj, key, _convert(f"[{section}] {key}", raw, getattr(obj, key)))


def load_config(path: str | None = DEFAULT_CONFIG_PATH) -> Config:
    """Load the configuration file; a missing file yields the defaults."""
    config = Config()
    if path:
        parser = configparser.ConfigParser(interpolation=None)
        try:
            with open(path, encoding="utf-8") as fh:
                parser.read_file(fh)
        except FileNotFoundError:
            log.warning("config file %s not found, using defaults", path)
        except configparser.Error as exc:
            raise ConfigError(f"{path}: {exc}") from exc
        _load_section(parser, "web", config.web)
        _load_section(parser, "helper", config.helper)
    validate(config)
    return config


def validate(config: Config) -> None:
    web = config.web
    if not 1 <= web.listen_port <= 65535:
        raise ConfigError("[web] listen_port must be between 1 and 65535")
    if not web.cookie_path.startswith("/"):
        raise ConfigError("[web] cookie_path must start with '/'")
    if web.session_max_lifetime < 60:
        raise ConfigError("[web] session_max_lifetime must be at least 60 seconds")
    if web.max_terminals < 1:
        raise ConfigError("[web] max_terminals must be at least 1")
    if web.scrollback_bytes < 4096:
        raise ConfigError("[web] scrollback_bytes must be at least 4096")
    if config.helper.token_lifetime < web.session_max_lifetime:
        raise ConfigError("[helper] token_lifetime must be >= [web] session_max_lifetime")
