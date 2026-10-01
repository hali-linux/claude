"""TrafficGate 통과 토큰 검증 (Python 3, 표준 라이브러리만 사용)

    from verify import verify_token
    claims = verify_token(token, secret, segment="event")   # 실패 시 None

토큰 형식: v1.<payload>.<signature>
  payload   = base64url(JSON {"s": 세그먼트, "t": 티켓, "iat": 발급, "exp": 만료})
  signature = base64url(HMAC-SHA256(secret, "v1." + payload))
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time


def _b64decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def verify_token(token: str, secret: str, segment: str | None = None, now: float | None = None):
    try:
        version, payload, sig = token.split(".")
    except (AttributeError, ValueError):
        return None
    if version != "v1":
        return None
    expected = hmac.new(secret.encode(), f"{version}.{payload}".encode(), hashlib.sha256).digest()
    try:
        if not hmac.compare_digest(expected, _b64decode(sig)):
            return None
        claims = json.loads(_b64decode(payload))
    except (ValueError, json.JSONDecodeError):
        return None
    if (now or time.time()) >= claims.get("exp", 0):
        return None
    if segment and claims.get("s") != segment:
        return None
    return claims


if __name__ == "__main__":
    import sys

    tok, sec = sys.argv[1], sys.argv[2]
    seg = sys.argv[3] if len(sys.argv) > 3 else None
    result = verify_token(tok, sec, seg)
    print(json.dumps(result) if result else "INVALID")
    sys.exit(0 if result else 1)
