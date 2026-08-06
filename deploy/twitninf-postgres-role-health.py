#!/usr/bin/env python3
"""Sonde HTTP locale indiquant si PostgreSQL est le writer courant."""

from __future__ import annotations

import json
import os
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


BIND = os.environ.get("ROLE_HEALTH_BIND", "127.0.0.1")
PORT = int(os.environ.get("ROLE_HEALTH_PORT", "8008"))


def postgres_state() -> dict[str, object]:
    result = subprocess.run(
        ["/usr/bin/psql", "-Atqc", "select pg_is_in_recovery()"],
        text=True,
        capture_output=True,
        timeout=2,
        check=False,
    )
    value = result.stdout.strip()
    online = result.returncode == 0 and value in {"t", "f"}
    return {
        "online": online,
        "in_recovery": value == "t" if online else None,
        "primary": online and value == "f",
    }


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 - API BaseHTTPRequestHandler
        state = postgres_state()
        expected = {
            "/primary": state["primary"],
            "/replica": state["online"] and state["in_recovery"],
            "/status": state["online"],
        }.get(self.path, False)
        body = json.dumps(state, separators=(",", ":")).encode("ascii")
        self.send_response(200 if expected else 503)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_args: object) -> None:
        return


if __name__ == "__main__":
    ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()
