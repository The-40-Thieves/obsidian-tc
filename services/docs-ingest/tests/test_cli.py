"""``docs-ingest setup``: non-interactive flags, interactive prompts with masking, URL validation,
and the endpoint probes. Prompts, getpass and urlopen are all injected, so no TTY or network."""

from __future__ import annotations

import urllib.error
from collections.abc import Callable
from pathlib import Path
from typing import Any, Self

import pytest

from obsidian_tc_docs_ingest import config
from obsidian_tc_docs_ingest.cli import main

CRAWL4AI = "http://crawl.example.com:11235"
GATEWAY = "https://gateway.example.com:4001/v1"


class _Response:
    status = 200

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *exc: object) -> None:
        return None


@pytest.fixture
def config_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "config" / "docs-ingest.env"
    monkeypatch.setenv("DOCS_INGEST_CONFIG", str(path))
    return path


@pytest.fixture
def calls() -> list[Any]:
    return []


@pytest.fixture
def opener(calls: list[Any]) -> Any:
    def open_ok(req: Any, timeout: float | None = None) -> _Response:
        calls.append(req)
        return _Response()

    return open_ok


def _answers(*values: str) -> Callable[[str], str]:
    remaining = iter(values)
    return lambda prompt: next(remaining)


def _no_input(prompt: str) -> str:
    raise AssertionError(f"unexpected prompt: {prompt}")


def test_non_interactive_flags_write_the_file(
    config_path: Path, opener: Any, calls: list[Any]
) -> None:
    code = main(
        [
            "setup",
            "--non-interactive",
            "--no-probe",
            "--crawl4ai-url",
            CRAWL4AI,
            "--langextract-base-url",
            GATEWAY,
            "--langextract-model-id",
            "openai/gpt-4o",
        ],
        input_fn=_no_input,
        getpass_fn=_no_input,
        opener=opener,
    )

    assert code == 0
    assert config.load() == {
        "CRAWL4AI_URL": CRAWL4AI,
        "LANGEXTRACT_BASE_URL": GATEWAY,
        "LANGEXTRACT_MODEL_ID": "openai/gpt-4o",
    }
    assert calls == []


def test_bad_scheme_exits_2_and_writes_nothing(
    config_path: Path, opener: Any, capsys: pytest.CaptureFixture[str]
) -> None:
    code = main(
        ["setup", "--non-interactive", "--crawl4ai-url", "ftp://crawl.example.com/"],
        input_fn=_no_input,
        getpass_fn=_no_input,
        opener=opener,
    )

    assert code == 2
    assert not config_path.exists()
    assert "http" in capsys.readouterr().err


def test_base_url_without_v1_exits_2_and_writes_nothing(
    config_path: Path, opener: Any, capsys: pytest.CaptureFixture[str]
) -> None:
    code = main(
        [
            "setup",
            "--non-interactive",
            "--crawl4ai-url",
            CRAWL4AI,
            "--langextract-base-url",
            "https://gateway.example.com:4001",
        ],
        input_fn=_no_input,
        getpass_fn=_no_input,
        opener=opener,
    )

    assert code == 2
    assert not config_path.exists()
    assert "/v1" in capsys.readouterr().err


def test_interactive_empty_answers_keep_existing_values(
    config_path: Path, opener: Any, capsys: pytest.CaptureFixture[str]
) -> None:
    existing = {
        "CRAWL4AI_URL": CRAWL4AI,
        "LANGEXTRACT_BASE_URL": GATEWAY,
        "LANGEXTRACT_API_KEY": "sk-live-secret-1234",
    }
    config.save(existing)

    prompts: list[str] = []

    def record(prompt: str) -> str:
        prompts.append(prompt)
        return ""

    code = main(
        ["setup", "--no-probe"],
        input_fn=_answers("", "", ""),
        getpass_fn=record,
        opener=opener,
    )

    assert code == 0
    assert config.load() == existing
    # The secret is shown masked in its prompt label, never in full.
    assert "LANGEXTRACT_API_KEY [****1234]: " in prompts
    captured = capsys.readouterr()
    assert "sk-live-secret-1234" not in captured.out + captured.err


def test_interactive_new_secret_is_never_printed(
    config_path: Path, opener: Any, capsys: pytest.CaptureFixture[str]
) -> None:
    code = main(
        ["setup", "--no-probe"],
        input_fn=_answers(CRAWL4AI, GATEWAY, ""),
        getpass_fn=_answers("", "sk-new-secret-9876"),
        opener=opener,
    )

    assert code == 0
    assert config.load()["LANGEXTRACT_API_KEY"] == "sk-new-secret-9876"
    captured = capsys.readouterr()
    assert "sk-new-secret-9876" not in captured.out + captured.err


def test_interactive_invalid_base_url_reprompts(
    config_path: Path, opener: Any, capsys: pytest.CaptureFixture[str]
) -> None:
    code = main(
        ["setup", "--no-probe"],
        input_fn=_answers(CRAWL4AI, "https://gateway.example.com:4001", GATEWAY, ""),
        getpass_fn=_answers("", ""),
        opener=opener,
    )

    assert code == 0
    assert config.load()["LANGEXTRACT_BASE_URL"] == GATEWAY
    assert "/v1" in capsys.readouterr().out


def test_plain_http_to_remote_host_warns_but_still_saves(
    config_path: Path, opener: Any, capsys: pytest.CaptureFixture[str]
) -> None:
    code = main(
        [
            "setup",
            "--non-interactive",
            "--no-probe",
            "--crawl4ai-url",
            "http://crawl.example.com",
            "--langextract-base-url",
            GATEWAY,
        ],
        input_fn=_no_input,
        getpass_fn=_no_input,
        opener=opener,
    )

    assert code == 0
    assert config.load()["CRAWL4AI_URL"] == "http://crawl.example.com"
    assert "WARNING" in capsys.readouterr().out


def test_probe_200_reports_ok(
    config_path: Path, opener: Any, calls: list[Any], capsys: pytest.CaptureFixture[str]
) -> None:
    code = main(
        [
            "setup",
            "--non-interactive",
            "--crawl4ai-url",
            CRAWL4AI,
            "--langextract-base-url",
            GATEWAY,
            "--langextract-api-key",
            "sk-probe-5678",
        ],
        input_fn=_no_input,
        getpass_fn=_no_input,
        opener=opener,
    )

    assert code == 0
    urls = {req.full_url: req for req in calls}
    assert set(urls) == {f"{CRAWL4AI}/health", f"{GATEWAY}/models"}
    assert urls[f"{GATEWAY}/models"].get_header("Authorization") == "Bearer sk-probe-5678"
    out = capsys.readouterr().out
    assert "crawl4ai" in out and "OK" in out


def test_probe_failure_reports_fail_and_still_saves(
    config_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    def refuse(req: Any, timeout: float | None = None) -> None:
        raise urllib.error.URLError("connection refused")

    code = main(
        [
            "setup",
            "--non-interactive",
            "--crawl4ai-url",
            CRAWL4AI,
            "--langextract-base-url",
            GATEWAY,
        ],
        input_fn=_no_input,
        getpass_fn=_no_input,
        opener=refuse,
    )

    assert code == 0
    assert config.load() == {"CRAWL4AI_URL": CRAWL4AI, "LANGEXTRACT_BASE_URL": GATEWAY}
    out = capsys.readouterr().out
    assert "FAIL" in out and "connection refused" in out


def test_probe_error_never_echoes_the_secret(
    config_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    def refuse(req: Any, timeout: float | None = None) -> None:
        raise urllib.error.URLError("401 bad key sk-probe-5678")

    code = main(
        [
            "setup",
            "--non-interactive",
            "--crawl4ai-url",
            CRAWL4AI,
            "--langextract-base-url",
            GATEWAY,
            "--langextract-api-key",
            "sk-probe-5678",
        ],
        input_fn=_no_input,
        getpass_fn=_no_input,
        opener=refuse,
    )

    assert code == 0
    captured = capsys.readouterr()
    assert "sk-probe-5678" not in captured.out + captured.err
    assert "FAIL" in captured.out


def test_no_probe_makes_no_call(config_path: Path, calls: list[Any], opener: Any) -> None:
    code = main(
        [
            "setup",
            "--non-interactive",
            "--no-probe",
            "--crawl4ai-url",
            CRAWL4AI,
            "--langextract-base-url",
            GATEWAY,
        ],
        input_fn=_no_input,
        getpass_fn=_no_input,
        opener=opener,
    )

    assert code == 0
    assert calls == []
