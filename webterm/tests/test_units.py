import os
import tempfile
import unittest

from webterm.config import ConfigError, load_config
from webterm.ratelimit import LoginLimiter
from webterm.web import content_disposition


class ConfigTests(unittest.TestCase):
    def write(self, text):
        fd, path = tempfile.mkstemp(suffix=".conf")
        with os.fdopen(fd, "w") as fh:
            fh.write(text)
        self.addCleanup(os.unlink, path)
        return path

    def test_defaults_when_missing(self):
        config = load_config("/nonexistent/webterm.conf")
        self.assertEqual(config.web.listen_port, 8022)
        self.assertEqual(config.helper.allowed_groups, ("webterm-users",))

    def test_parse_types(self):
        path = self.write(
            "[web]\nlisten_port = 9000\ncookie_secure = no\ntrusted_proxies = 127.0.0.1, 10.0.0.0/8\n"
            "[helper]\nallowed_groups =\ndenied_users = root, admin\nallow_root = yes\n"
        )
        config = load_config(path)
        self.assertEqual(config.web.listen_port, 9000)
        self.assertFalse(config.web.cookie_secure)
        self.assertEqual(config.web.trusted_proxies, ("127.0.0.1", "10.0.0.0/8"))
        self.assertEqual(config.helper.allowed_groups, ())
        self.assertEqual(config.helper.denied_users, ("root", "admin"))
        self.assertTrue(config.helper.allow_root)

    def test_invalid_values(self):
        with self.assertRaises(ConfigError):
            load_config(self.write("[web]\nlisten_port = abc\n"))
        with self.assertRaises(ConfigError):
            load_config(self.write("[web]\ncookie_secure = maybe\n"))
        with self.assertRaises(ConfigError):
            load_config(self.write("[web]\nsession_max_lifetime = 90000\n"))  # > token_lifetime


class LimiterTests(unittest.TestCase):
    def test_lockout_and_expiry(self):
        now = [1000.0]
        limiter = LoginLimiter(3, window=60, lockout=300, clock=lambda: now[0])
        for _ in range(2):
            limiter.failure("ip:1", "user:a")
        self.assertEqual(limiter.retry_after("ip:1"), 0)
        limiter.failure("ip:1", "user:a")
        self.assertEqual(limiter.retry_after("ip:1"), 300)
        self.assertEqual(limiter.retry_after("ip:2", "user:a"), 300)
        now[0] += 301
        self.assertEqual(limiter.retry_after("ip:1", "user:a"), 0)

    def test_failures_outside_window_are_forgotten(self):
        now = [0.0]
        limiter = LoginLimiter(3, window=60, lockout=300, clock=lambda: now[0])
        limiter.failure("k")
        limiter.failure("k")
        now[0] += 61
        limiter.failure("k")
        self.assertEqual(limiter.retry_after("k"), 0)

    def test_success_resets(self):
        limiter = LoginLimiter(2, 60, 300)
        limiter.failure("k")
        limiter.success("k")
        limiter.failure("k")
        self.assertEqual(limiter.retry_after("k"), 0)


class HelpersTests(unittest.TestCase):
    def test_content_disposition(self):
        value = content_disposition('보고서 "최종".txt')
        self.assertIn('filename="', value)
        self.assertNotIn('"최종"', value.split("filename*=")[0])
        self.assertIn("filename*=UTF-8''%EB%B3%B4", value)


if __name__ == "__main__":
    unittest.main()
