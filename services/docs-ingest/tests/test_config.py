"""Endpoint config file: dotenv round-trip, env-over-file precedence, mode 0600, and the
missing-setting error that points at ``docs-ingest setup``."""

from __future__ import annotations

import os
import stat
import sys
from pathlib import Path

import pytest

from obsidian_tc_docs_ingest import config, pipeline

posix_only = pytest.mark.skipif(sys.platform == "win32", reason="POSIX file modes")


def _point_at(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "config" / "docs-ingest.env"
    monkeypatch.setenv("DOCS_INGEST_CONFIG", str(path))
    return path


def test_save_then_load_round_trips_values_with_hash_spaces_and_quotes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _point_at(tmp_path, monkeypatch)
    values = {
        "CRAWL4AI_URL": "http://localhost:11235",
        "CRAWL4AI_API_TOKEN": 'tok # not a comment, "quoted" and spaced',
        "LANGEXTRACT_API_KEY": "it's a \\ backslash",
    }

    config.save(values)

    assert config.load() == values


def test_load_skips_comments_and_blank_lines(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = _point_at(tmp_path, monkeypatch)
    path.parent.mkdir(parents=True)
    path.write_text("# written by hand\n\nCRAWL4AI_URL=http://h:1\n", encoding="utf-8")

    assert config.load() == {"CRAWL4AI_URL": "http://h:1"}


def test_missing_file_loads_as_empty(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _point_at(tmp_path, monkeypatch)

    assert config.load() == {}


def test_default_path_follows_xdg_config_home(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("DOCS_INGEST_CONFIG", raising=False)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))

    assert config.path() == tmp_path / "obsidian-tc" / "docs-ingest.env"


def test_environment_overrides_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _point_at(tmp_path, monkeypatch)
    config.save({"CRAWL4AI_URL": "http://from-file:1"})
    monkeypatch.setenv("CRAWL4AI_URL", "http://from-env:2")

    assert config.get("CRAWL4AI_URL") == "http://from-env:2"


def test_empty_environment_value_falls_back_to_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _point_at(tmp_path, monkeypatch)
    config.save({"CRAWL4AI_URL": "http://from-file:1"})
    monkeypatch.setenv("CRAWL4AI_URL", "  ")

    assert config.get("CRAWL4AI_URL") == "http://from-file:1"


def test_file_used_when_environment_unset(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _point_at(tmp_path, monkeypatch)
    config.save({"CRAWL4AI_URL": "http://from-file:1"})
    monkeypatch.delenv("CRAWL4AI_URL", raising=False)

    assert config.get("CRAWL4AI_URL") == "http://from-file:1"
    assert pipeline._required_env("CRAWL4AI_URL", "your crawl4ai server") == "http://from-file:1"


def test_unset_in_both_places_fails_naming_variable_and_setup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _point_at(tmp_path, monkeypatch)
    monkeypatch.delenv("CRAWL4AI_URL", raising=False)

    with pytest.raises(RuntimeError, match=r"CRAWL4AI_URL is not set.*docs-ingest setup"):
        pipeline._required_env("CRAWL4AI_URL", "your crawl4ai server")


@posix_only
def test_saved_file_is_mode_0600(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = _point_at(tmp_path, monkeypatch)

    config.save({"LANGEXTRACT_API_KEY": "sk-test"})

    assert stat.S_IMODE(path.stat().st_mode) == 0o600


@posix_only
def test_existing_world_readable_file_is_tightened_to_0600(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = _point_at(tmp_path, monkeypatch)
    path.parent.mkdir(parents=True)
    path.write_text("CRAWL4AI_URL=http://h:1\n", encoding="utf-8")
    os.chmod(path, 0o644)

    config.save({"CRAWL4AI_URL": "http://h:1"})

    assert stat.S_IMODE(path.stat().st_mode) == 0o600
