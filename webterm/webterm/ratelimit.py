"""Login brute-force protection (per client IP and per username)."""

from __future__ import annotations

import time


class LoginLimiter:
    def __init__(self, max_failures: int, window: int, lockout: int, clock=time.monotonic):
        self.max_failures = max_failures
        self.window = window
        self.lockout = lockout
        self._clock = clock
        self._failures: dict[str, list[float]] = {}
        self._locked_until: dict[str, float] = {}

    def retry_after(self, *keys: str) -> int:
        """Seconds until any of ``keys`` may try again (0 = allowed now)."""
        if self.max_failures <= 0:
            return 0
        now = self._clock()
        wait = 0.0
        for key in keys:
            until = self._locked_until.get(key)
            if until is not None:
                if until > now:
                    wait = max(wait, until - now)
                else:
                    del self._locked_until[key]
        return int(wait + 0.999)

    def failure(self, *keys: str) -> None:
        if self.max_failures <= 0:
            return
        now = self._clock()
        for key in keys:
            recent = [t for t in self._failures.get(key, []) if now - t < self.window]
            recent.append(now)
            if len(recent) >= self.max_failures:
                self._locked_until[key] = now + self.lockout
                recent = []
            self._failures[key] = recent

    def success(self, *keys: str) -> None:
        for key in keys:
            self._failures.pop(key, None)
            self._locked_until.pop(key, None)

    def cleanup(self) -> None:
        now = self._clock()
        for key in [k for k, v in self._failures.items() if not v or now - v[-1] >= self.window]:
            del self._failures[key]
        for key in [k for k, v in self._locked_until.items() if v <= now]:
            del self._locked_until[key]
