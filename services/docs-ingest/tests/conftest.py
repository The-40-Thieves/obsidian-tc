"""Shared fixtures: keep every test off the operator's real endpoint config.

Live settings resolve from the environment first, then from the setup file. Pointing
``DOCS_INGEST_CONFIG`` at an empty file means a developer's ~/.config copy can never leak into
a test that expects a setting to be unset.
"""

from __future__ import annotations

import threading
from collections.abc import Callable, Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

_SETTING_ENV = (
    "CRAWL4AI_URL",
    "CRAWL4AI_API_TOKEN",
    "LANGEXTRACT_BASE_URL",
    "LANGEXTRACT_API_KEY",
    "LANGEXTRACT_MODEL_ID",
    "LITELLM_AGENT_KEY",
)


class _Recorder(BaseHTTPRequestHandler):
    """Records (method, path, Authorization) for every request, then answers with the server's canned reply."""

    def _answer(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(length)
        server = self.server
        server.seen.append((self.command, self.path, self.headers.get("Authorization")))  # type: ignore[attr-defined]
        self.send_response(server.status)  # type: ignore[attr-defined]
        if server.location:  # type: ignore[attr-defined]
            self.send_header("Location", server.location)  # type: ignore[attr-defined]
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(server.body)  # type: ignore[attr-defined]

    do_GET = _answer
    do_POST = _answer

    def log_message(self, format: str, *args: object) -> None:
        return None


@pytest.fixture
def local_http() -> Iterator[Callable[..., ThreadingHTTPServer]]:
    """Start a 127.0.0.1 server (ephemeral port) that records requests in ``server.seen``."""
    started: list[ThreadingHTTPServer] = []

    def start(
        status: int = 200, location: str | None = None, body: bytes = b"{}"
    ) -> ThreadingHTTPServer:
        server = ThreadingHTTPServer(("127.0.0.1", 0), _Recorder)
        server.status = status  # type: ignore[attr-defined]
        server.location = location  # type: ignore[attr-defined]
        server.body = body  # type: ignore[attr-defined]
        server.seen = []  # type: ignore[attr-defined]
        threading.Thread(target=server.serve_forever, daemon=True).start()
        started.append(server)
        return server

    yield start
    for server in started:
        server.shutdown()
        server.server_close()


@pytest.fixture(autouse=True)
def _isolated_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    empty = tmp_path / "no-user-config" / "docs-ingest.env"
    empty.parent.mkdir()
    empty.write_text("", encoding="utf-8")
    monkeypatch.setenv("DOCS_INGEST_CONFIG", str(empty))
    for name in _SETTING_ENV:
        monkeypatch.delenv(name, raising=False)
