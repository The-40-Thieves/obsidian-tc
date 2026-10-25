"""Shared fixtures: keep every test off the operator's real endpoint config.

Live settings resolve from the environment first, then from the setup file. Pointing
``DOCS_INGEST_CONFIG`` at an empty file means a developer's ~/.config copy can never leak into
a test that expects a setting to be unset.
"""

from __future__ import annotations

from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def _isolated_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    empty = tmp_path / "no-user-config" / "docs-ingest.env"
    empty.parent.mkdir()
    empty.write_text("", encoding="utf-8")
    monkeypatch.setenv("DOCS_INGEST_CONFIG", str(empty))
