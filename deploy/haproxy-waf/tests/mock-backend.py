#!/usr/bin/python3
"""Minimal stand-in for the Next.js app, for testing the HAProxy/WAF stack.

It answers /api/health with 200 and echoes every other request as JSON
(method, path, forwarded headers, WAF headers, body size), so you can check
what HAProxy forwards before the real app is deployed.

    python3 mock-backend.py --port 3000
"""
import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ECHO_HEADERS = ("host", "x-forwarded-for", "x-forwarded-proto", "x-forwarded-port", "x-real-ip",
                "x-request-id", "x-waf-action", "x-waf-labels", "content-type")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quiet
        pass

    def read_body(self):
        if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
            total = 0
            while True:
                size = int(self.rfile.readline().split(b";")[0].strip() or b"0", 16)
                if size == 0:
                    self.rfile.readline()
                    return total
                self.rfile.read(size)
                self.rfile.readline()
                total += size
        n = int(self.headers.get("Content-Length") or 0)
        remaining = n
        while remaining > 0:
            chunk = self.rfile.read(min(remaining, 1 << 20))
            if not chunk:
                break
            remaining -= len(chunk)
        return n - remaining

    def handle_any(self):
        size = self.read_body()
        if self.path == "/api/health":
            body = {"ok": True}
        else:
            body = {
                "method": self.command,
                "path": self.path,
                "bodyBytes": size,
                "headers": {h: self.headers.get(h) for h in ECHO_HEADERS if self.headers.get(h) is not None},
            }
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = do_OPTIONS = handle_any


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=3000)
    a = p.parse_args()
    ThreadingHTTPServer((a.host, a.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
