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


@pytest.mark.parametrize(
    "bad",
    ["a\nb", "a\rb", "a\x0bb", "a\x0cb", "a\x1cb", "a\x1db", "a\x1eb", "a\x85b", "a b", "a\udcffb"],
)
def test_save_rejects_non_printable_values_and_keeps_the_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, bad: str
) -> None:
    path = _point_at(tmp_path, monkeypatch)
    path.parent.mkdir(parents=True)
    path.write_text("LANGEXTRACT_API_KEY=sk-precious\n", encoding="utf-8")

    with pytest.raises(ValueError, match="LANGEXTRACT_MODEL_ID"):
        config.save({"LANGEXTRACT_MODEL_ID": bad})

    assert path.read_text(encoding="utf-8") == "LANGEXTRACT_API_KEY=sk-precious\n"


@pytest.mark.parametrize("sep", ["\x0b", "\x0c", "\x1c", "\x1d", "\x1e", "\x85", " "])
def test_load_splits_only_on_newlines(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, sep: str
) -> None:
    path = _point_at(tmp_path, monkeypatch)
    path.parent.mkdir(parents=True)
    value = f"tok{sep}LANGEXTRACT_BASE_URL=http://evil.example/v1"
    path.write_bytes(f"CRAWL4AI_API_TOKEN={value}\n".encode())

    assert config.load() == {"CRAWL4AI_API_TOKEN": value}


def test_load_accepts_crlf_line_endings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = _point_at(tmp_path, monkeypatch)
    path.parent.mkdir(parents=True)
    path.write_bytes(b"CRAWL4AI_URL=http://h:1\r\nLANGEXTRACT_MODEL_ID=m\r\n")

    assert config.load() == {"CRAWL4AI_URL": "http://h:1", "LANGEXTRACT_MODEL_ID": "m"}


def test_key_prefers_fresh_litellm_env_over_stale_file_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _point_at(tmp_path, monkeypatch)
    config.save({"LANGEXTRACT_API_KEY": "stale-file-key"})
    monkeypatch.delenv("LANGEXTRACT_API_KEY", raising=False)
    monkeypatch.setenv("LITELLM_AGENT_KEY", "fresh-env-key")

    assert config.get("LANGEXTRACT_API_KEY") == "fresh-env-key"


def test_key_checks_both_env_names_before_the_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _point_at(tmp_path, monkeypatch)
    config.save({"LANGEXTRACT_API_KEY": "file-key"})
    monkeypatch.setenv("LANGEXTRACT_API_KEY", "env-key")
    monkeypatch.setenv("LITELLM_AGENT_KEY", "env-litellm")

    assert config.get("LANGEXTRACT_API_KEY") == "env-key"


def test_key_falls_back_to_file_litellm_agent_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _point_at(tmp_path, monkeypatch)
    config.save({"LITELLM_AGENT_KEY": "file-litellm"})
    monkeypatch.delenv("LANGEXTRACT_API_KEY", raising=False)
    monkeypatch.delenv("LITELLM_AGENT_KEY", raising=False)

    assert config.get("LANGEXTRACT_API_KEY") == "file-litellm"


@posix_only
def test_unreadable_file_is_ignored_with_one_warning(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        pytest.skip("root reads any file")
    path = _point_at(tmp_path, monkeypatch)
    path.parent.mkdir(parents=True)
    path.write_text("LANGEXTRACT_API_KEY=sk-secret-in-file\n", encoding="utf-8")
    os.chmod(path, 0)
    monkeypatch.setenv("CRAWL4AI_URL", "http://env.example:1")

    assert config.get("CRAWL4AI_URL") == "http://env.example:1"
    assert config.get("LANGEXTRACT_API_KEY") is None
    assert config.get("LANGEXTRACT_MODEL_ID") is None

    err = capsys.readouterr().err
    assert err.count("ignoring") == 1
    assert "PermissionError" in err and str(path) in err
    assert "sk-secret-in-file" not in err


def test_undecodable_file_is_ignored_with_one_warning(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    path = _point_at(tmp_path, monkeypatch)
    path.parent.mkdir(parents=True)
    path.write_bytes(b"LANGEXTRACT_API_KEY=\xff\xfe\n")
    monkeypatch.setenv("CRAWL4AI_URL", "http://env.example:1")

    assert config.get("CRAWL4AI_URL") == "http://env.example:1"
    assert config.get("LANGEXTRACT_API_KEY") is None
    assert config.get("LANGEXTRACT_MODEL_ID") is None

    err = capsys.readouterr().err
    assert err.count("ignoring") == 1
    assert "UnicodeDecodeError" in err and str(path) in err


def test_unresolvable_home_is_ignored_with_one_warning(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv("DOCS_INGEST_CONFIG", raising=False)
    monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)

    def no_home() -> Path:
        raise RuntimeError("Could not determine home directory.")

    monkeypatch.setattr(config.Path, "home", staticmethod(no_home))
    monkeypatch.setenv("CRAWL4AI_URL", "http://env.example:1")

    assert config.get("CRAWL4AI_URL") == "http://env.example:1"
    assert config.get("LANGEXTRACT_BASE_URL") is None

    err = capsys.readouterr().err
    assert err.count("ignoring") == 1
    assert "RuntimeError" in err
