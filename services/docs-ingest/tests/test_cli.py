"""``docs-ingest setup``: non-interactive flags, interactive prompts with masking, URL validation,
and the endpoint probes. Prompts, getpass and urlopen are all injected, so no TTY or network."""

from __future__ import annotations

import io
import sys
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
    lines = capsys.readouterr().out.splitlines()
    assert any(line.startswith("crawl4ai: OK") for line in lines)
    assert any(line.startswith("gateway: OK") for line in lines)


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


def test_each_probe_sends_only_its_own_credential(
    config_path: Path, opener: Any, calls: list[Any]
) -> None:
    code = main(
        [
            "setup",
            "--non-interactive",
            "--crawl4ai-url",
            CRAWL4AI,
            "--crawl4ai-token",
            "tok-crawl-1234",
            "--langextract-base-url",
            GATEWAY,
            "--langextract-api-key",
            "sk-gateway-5678",
        ],
        input_fn=_no_input,
        getpass_fn=_no_input,
        opener=opener,
    )

    assert code == 0
    urls = {req.full_url: req for req in calls}
    assert urls[f"{CRAWL4AI}/health"].get_header("Authorization") == "Bearer tok-crawl-1234"
    assert urls[f"{GATEWAY}/models"].get_header("Authorization") == "Bearer sk-gateway-5678"


def test_crawl4ai_probe_gets_no_key_when_only_the_gateway_key_is_set(
    config_path: Path, opener: Any, calls: list[Any]
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
            "sk-gateway-5678",
        ],
        input_fn=_no_input,
        getpass_fn=_no_input,
        opener=opener,
    )

    assert code == 0
    urls = {req.full_url: req for req in calls}
    assert urls[f"{CRAWL4AI}/health"].get_header("Authorization") is None


def test_probe_non_2xx_status_reports_fail(
    config_path: Path, calls: list[Any], capsys: pytest.CaptureFixture[str]
) -> None:
    class _ServerError(_Response):
        status = 500

    def answer(req: Any, timeout: float | None = None) -> _ServerError:
        calls.append(req)
        return _ServerError()

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
        opener=answer,
    )

    assert code == 0
    lines = capsys.readouterr().out.splitlines()
    assert any(line.startswith("crawl4ai: FAIL") and "HTTP 500" in line for line in lines)
    assert any(line.startswith("gateway: FAIL") and "HTTP 500" in line for line in lines)


def test_redirected_probe_is_reported_and_the_credentials_stay_home(
    config_path: Path, local_http: Any, capsys: pytest.CaptureFixture[str]
) -> None:
    other = local_http()
    origin = local_http(status=302, location=f"http://127.0.0.1:{other.server_port}/elsewhere")
    base = f"http://127.0.0.1:{origin.server_port}"

    code = main(
        [
            "setup",
            "--non-interactive",
            "--crawl4ai-url",
            base,
            "--crawl4ai-token",
            "tok-crawl-1234",
            "--langextract-base-url",
            f"{base}/v1",
            "--langextract-api-key",
            "sk-gateway-5678",
        ],
        input_fn=_no_input,
        getpass_fn=_no_input,
    )

    assert code == 0
    assert origin.seen, "both probes should reach the origin"
    assert other.seen == []
    out = capsys.readouterr().out
    assert "FAIL" in out and "redirected to 127.0.0.1" in out
    assert ": OK" not in out


@pytest.mark.parametrize(
    "sep", ["\n", "\x0b", "\x0c", "\x1c", "\x1d", "\x1e", "\x85", " ", "\udcff"]
)
def test_value_with_a_line_break_or_control_char_exits_2_naming_the_variable(
    config_path: Path, opener: Any, capsys: pytest.CaptureFixture[str], sep: str
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
            f"m{sep}LANGEXTRACT_BASE_URL=http://evil.example/v1{sep}#",
        ],
        input_fn=_no_input,
        getpass_fn=_no_input,
        opener=opener,
    )

    captured = capsys.readouterr()
    assert code == 2
    assert not config_path.exists()
    assert "LANGEXTRACT_MODEL_ID" in captured.err
    assert "evil.example" not in captured.out + captured.err


def test_failed_validation_keeps_the_existing_file(config_path: Path, opener: Any) -> None:
    existing = (
        "CRAWL4AI_URL=http://crawl.example.com:11235\n"
        "LANGEXTRACT_BASE_URL=https://gateway.example.com:4001/v1\n"
        "LANGEXTRACT_API_KEY=sk-precious-0001\n"
    )
    config_path.parent.mkdir(parents=True)
    config_path.write_text(existing, encoding="utf-8")

    code = main(
        ["setup", "--non-interactive", "--no-probe", "--langextract-model-id", "bad\udcff"],
        input_fn=_no_input,
        getpass_fn=_no_input,
        opener=opener,
    )

    assert code == 2
    assert config_path.read_text(encoding="utf-8") == existing


@pytest.mark.parametrize(
    ("flag", "name"),
    [("--crawl4ai-token", "CRAWL4AI_API_TOKEN"), ("--langextract-api-key", "LANGEXTRACT_API_KEY")],
)
def test_secret_flag_reads_one_stdin_line_when_given_a_dash(
    config_path: Path,
    opener: Any,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    flag: str,
    name: str,
) -> None:
    monkeypatch.setattr(sys, "stdin", io.StringIO("sk-from-stdin-4321\n"))

    code = main(
        [
            "setup",
            "--non-interactive",
            "--no-probe",
            "--crawl4ai-url",
            CRAWL4AI,
            "--langextract-base-url",
            GATEWAY,
            flag,
            "-",
        ],
        input_fn=_no_input,
        getpass_fn=_no_input,
        opener=opener,
    )

    assert code == 0
    assert config.load()[name] == "sk-from-stdin-4321"
    captured = capsys.readouterr()
    assert "sk-from-stdin-4321" not in captured.out + captured.err


def test_secret_dash_with_empty_stdin_exits_2_and_writes_nothing(
    config_path: Path,
    opener: Any,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(sys, "stdin", io.StringIO(""))

    code = main(
        [
            "setup",
            "--non-interactive",
            "--no-probe",
            "--crawl4ai-url",
            CRAWL4AI,
            "--langextract-base-url",
            GATEWAY,
            "--langextract-api-key",
            "-",
        ],
        input_fn=_no_input,
        getpass_fn=_no_input,
        opener=opener,
    )

    assert code == 2
    assert not config_path.exists()
    assert "LANGEXTRACT_API_KEY" in capsys.readouterr().err


def test_flag_values_become_the_interactive_defaults(config_path: Path, opener: Any) -> None:
    prompts: list[str] = []

    def record(prompt: str) -> str:
        prompts.append(prompt)
        if len(prompts) > 10:  # a required prompt re-asks forever on an empty answer
            raise EOFError
        return ""

    code = main(
        [
            "setup",
            "--no-probe",
            "--crawl4ai-url",
            CRAWL4AI,
            "--langextract-base-url",
            GATEWAY,
            "--langextract-api-key",
            "sk-flag-0001",
        ],
        input_fn=record,
        getpass_fn=record,
        opener=opener,
    )

    assert code == 0
    assert f"CRAWL4AI_URL [{CRAWL4AI}]: " in prompts
    assert f"LANGEXTRACT_BASE_URL [{GATEWAY}]: " in prompts
    assert "LANGEXTRACT_API_KEY [****0001]: " in prompts
    assert config.load() == {
        "CRAWL4AI_URL": CRAWL4AI,
        "LANGEXTRACT_BASE_URL": GATEWAY,
        "LANGEXTRACT_API_KEY": "sk-flag-0001",
    }


@pytest.mark.parametrize(
    ("flag", "value", "name"),
    [
        ("--crawl4ai-url", "https://admin:hunter2@crawl.example.com", "CRAWL4AI_URL"),
        ("--crawl4ai-url", "https://token-only@crawl.example.com", "CRAWL4AI_URL"),
        (
            "--langextract-base-url",
            "https://gw:s3cret@gateway.example.com:4001/v1",
            "LANGEXTRACT_BASE_URL",
        ),
    ],
)
def test_url_with_credentials_is_rejected_without_echoing_them(
    config_path: Path,
    opener: Any,
    capsys: pytest.CaptureFixture[str],
    flag: str,
    value: str,
    name: str,
) -> None:
    urls = {"--crawl4ai-url": CRAWL4AI, "--langextract-base-url": GATEWAY}
    urls[flag] = value
    argv = ["setup", "--non-interactive", "--no-probe"]
    for option, url in urls.items():
        argv += [option, url]

    code = main(argv, input_fn=_no_input, getpass_fn=_no_input, opener=opener)

    captured = capsys.readouterr()
    assert code == 2
    assert not config_path.exists()
    assert name in captured.err
    assert "hunter2" not in captured.out + captured.err
    assert "s3cret" not in captured.out + captured.err
    assert "token-only" not in captured.out + captured.err


def test_uppercase_http_scheme_still_warns(
    config_path: Path, opener: Any, capsys: pytest.CaptureFixture[str]
) -> None:
    code = main(
        [
            "setup",
            "--non-interactive",
            "--no-probe",
            "--crawl4ai-url",
            "HTTP://crawl.example.com",
            "--langextract-base-url",
            GATEWAY,
        ],
        input_fn=_no_input,
        getpass_fn=_no_input,
        opener=opener,
    )

    assert code == 0
    assert "WARNING" in capsys.readouterr().out


@pytest.mark.parametrize(
    ("token", "wording"),
    [("tok-crawl-1234", "bearer key travels in clear"), (None, "traffic is unencrypted")],
)
def test_plain_http_warning_names_the_bearer_key_only_when_one_is_set(
    config_path: Path,
    opener: Any,
    capsys: pytest.CaptureFixture[str],
    token: str | None,
    wording: str,
) -> None:
    argv = [
        "setup",
        "--non-interactive",
        "--no-probe",
        "--crawl4ai-url",
        "http://crawl.example.com",
        "--langextract-base-url",
        GATEWAY,
    ]
    if token:
        argv += ["--crawl4ai-token", token]

    code = main(argv, input_fn=_no_input, getpass_fn=_no_input, opener=opener)

    assert code == 0
    out = capsys.readouterr().out
    assert wording in out
    assert ("bearer key" in out) is (token is not None)


@pytest.mark.parametrize(
    ("url", "warns"),
    [
        ("http://localhost:11235", False),
        ("http://127.0.0.2:11235", False),
        ("http://[::1]:11235", False),
        ("http://crawl.example.com", True),
        ("https://crawl.example.com", False),
    ],
)
def test_plain_http_warning_follows_the_host_and_scheme(
    config_path: Path, opener: Any, capsys: pytest.CaptureFixture[str], url: str, warns: bool
) -> None:
    code = main(
        [
            "setup",
            "--non-interactive",
            "--no-probe",
            "--crawl4ai-url",
            url,
            "--langextract-base-url",
            GATEWAY,
        ],
        input_fn=_no_input,
        getpass_fn=_no_input,
        opener=opener,
    )

    assert code == 0
    assert ("WARNING" in capsys.readouterr().out) is warns


@pytest.mark.parametrize(
    ("secret", "shown"), [("sk-short-11", "****"), ("abcdefghijkl", "****ijkl")]
)
def test_secret_prompt_shows_last_four_only_for_long_values(
    config_path: Path, opener: Any, secret: str, shown: str
) -> None:
    config.save(
        {"CRAWL4AI_URL": CRAWL4AI, "LANGEXTRACT_BASE_URL": GATEWAY, "LANGEXTRACT_API_KEY": secret}
    )
    prompts: list[str] = []

    def record(prompt: str) -> str:
        prompts.append(prompt)
        return ""

    code = main(["setup", "--no-probe"], input_fn=record, getpass_fn=record, opener=opener)

    assert code == 0
    assert f"LANGEXTRACT_API_KEY [{shown}]: " in prompts


def test_saved_value_overridden_by_environment_is_named_not_printed(
    config_path: Path,
    opener: Any,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setenv("CRAWL4AI_URL", "https://env-only.example:9")

    code = main(
        [
            "setup",
            "--non-interactive",
            "--no-probe",
            "--crawl4ai-url",
            "https://crawl.example.com:11235",
            "--langextract-base-url",
            GATEWAY,
        ],
        input_fn=_no_input,
        getpass_fn=_no_input,
        opener=opener,
    )

    assert code == 0
    out = capsys.readouterr().out
    assert "CRAWL4AI_URL" in out
    assert "env-only.example" not in out


def test_saved_key_overridden_by_litellm_env_is_named_not_printed(
    config_path: Path,
    opener: Any,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setenv("LITELLM_AGENT_KEY", "sk-env-litellm-9999")

    code = main(
        [
            "setup",
            "--non-interactive",
            "--no-probe",
            "--crawl4ai-url",
            "https://crawl.example.com:11235",
            "--langextract-base-url",
            GATEWAY,
            "--langextract-api-key",
            "sk-file-key-0000",
        ],
        input_fn=_no_input,
        getpass_fn=_no_input,
        opener=opener,
    )

    assert code == 0
    out = capsys.readouterr().out
    assert "LITELLM_AGENT_KEY" in out
    assert "sk-env-litellm" not in out and "sk-file-key" not in out
