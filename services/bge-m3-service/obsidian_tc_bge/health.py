"""Liveness (process up) vs readiness (model loaded) - separate signals, per the contract."""

from __future__ import annotations

import threading


class Readiness:
    def __init__(self) -> None:
        self._ready = False
        self._error: str | None = None
        self._lock = threading.Lock()

    def mark_ready(self) -> None:
        with self._lock:
            self._ready = True
            self._error = None

    def mark_error(self, message: str) -> None:
        with self._lock:
            self._ready = False
            self._error = message

    @property
    def ready(self) -> bool:
        with self._lock:
            return self._ready

    @property
    def error(self) -> str | None:
        with self._lock:
            return self._error
