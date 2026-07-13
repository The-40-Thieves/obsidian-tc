"""Readiness: liveness vs readiness signal, thread-safe transitions."""

from __future__ import annotations

from obsidian_tc_bge.health import Readiness


def test_starts_not_ready():
    r = Readiness()
    assert r.ready is False
    assert r.error is None


def test_mark_ready_then_error():
    r = Readiness()
    r.mark_ready()
    assert r.ready is True
    assert r.error is None
    r.mark_error("boom")
    assert r.ready is False
    assert r.error == "boom"
