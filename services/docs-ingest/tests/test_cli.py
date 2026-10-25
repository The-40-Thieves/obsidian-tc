"""``docs-ingest setup``: non-interactive flags, interactive prompts with masking, URL validation,
and the endpoint probes. Prompts, getpass and urlopen are all injected, so no TTY or network."""

from __future__ import annotations

import http.client
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


def test_two_dash_secrets_exit_2_and_write_nothing(
    config_path: Path,
    opener: Any,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    # argparse keeps no flag order, so two `-` secrets would be read in the settings' order and
    # a reversed command line would store each secret under the other's name.
    monkeypatch.setattr(sys, "stdin", io.StringIO("sk-GATEWAY-KEY-0001\ntok-CRAWL-TOKEN-0002\n"))

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
            "--crawl4ai-token",
            "-",
        ],
        input_fn=_no_input,
        getpass_fn=_no_input,
        opener=opener,
    )

    assert code == 2
    assert not config_path.exists()
    assert "only one" in capsys.readouterr().err


class _Tty(io.StringIO):
    def isatty(self) -> bool:
        return True


def test_dash_secret_on_a_terminal_is_read_without_echo(
    config_path: Path,
    opener: Any,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(sys, "stdin", _Tty("sk-echoed-on-tty-9999\n"))
    prompts: list[str] = []

    def hidden(prompt: str) -> str:
        prompts.append(prompt)
        return "sk-typed-hidden-1111"

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
        getpass_fn=hidden,
        opener=opener,
    )

    assert code == 0
    assert prompts and "LANGEXTRACT_API_KEY" in prompts[0]
    assert config.load()["LANGEXTRACT_API_KEY"] == "sk-typed-hidden-1111"


def test_unreadable_existing_file_exits_2_naming_the_path(
    config_path: Path, opener: Any, capsys: pytest.CaptureFixture[str]
) -> None:
    config_path.parent.mkdir(parents=True)
    config_path.write_bytes(b"LANGEXTRACT_MODEL_ID=\xff\n")

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

    assert code == 2
    err = capsys.readouterr().err
    assert str(config_path) in err and "UnicodeDecodeError" in err
    assert config_path.read_bytes() == b"LANGEXTRACT_MODEL_ID=\xff\n"


def test_probe_never_prints_server_control_characters(
    config_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    def garbage(req: Any, timeout: float | None = None) -> None:
        raise http.client.BadStatusLine("\x1b[2J\x1b]0;PWNED\x07 garbage status\r\n")

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
        opener=garbage,
    )

    assert code == 0
    out = capsys.readouterr().out
    assert "FAIL" in out
    assert "\x1b" not in out and "\x07" not in out


def test_plain_http_warning_counts_a_key_from_the_environment(
    config_path: Path,
    opener: Any,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setenv("LITELLM_AGENT_KEY", "sk-env-only-key-0000")

    code = main(
        [
            "setup",
            "--non-interactive",
            "--no-probe",
            "--crawl4ai-url",
            CRAWL4AI,
            "--langextract-base-url",
            "http://gateway.example.com:4001/v1",
        ],
        input_fn=_no_input,
        getpass_fn=_no_input,
        opener=opener,
    )

    assert code == 0
    gateway_warning = [
        line for line in capsys.readouterr().out.splitlines() if "LANGEXTRACT_BASE_URL" in line
    ]
    assert gateway_warning and "bearer key travels in clear" in gateway_warning[0]


def _setup_args(*extra: str) -> list[str]:
    return [
        "setup",
        "--non-interactive",
        "--crawl4ai-url",
        CRAWL4AI,
        "--langextract-base-url",
        GATEWAY,
        *extra,
    ]


def test_secret_with_escape_text_is_masked_after_escaping(
    config_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    # A printable secret that spells an escape sequence: a server echoing it back with a real ESC
    # must not have the escaping rebuild the secret's text after the mask missed it.
    secret = "sk-pa\\x1bss-0123456789"

    def echo(req: Any, timeout: float | None = None) -> None:
        raise http.client.BadStatusLine("sk-pa\x1bss-0123456789")

    code = main(
        _setup_args("--langextract-api-key", secret),
        input_fn=_no_input,
        getpass_fn=_no_input,
        opener=echo,
    )

    assert code == 0
    assert secret not in capsys.readouterr().out


def test_secret_starting_with_another_secret_is_masked_whole(
    config_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    def echo(req: Any, timeout: float | None = None) -> None:
        raise urllib.error.URLError("tok-abcdefgh-and-much-more-SECRET")

    code = main(
        _setup_args(
            "--crawl4ai-token",
            "tok-abcdefgh",
            "--langextract-api-key",
            "tok-abcdefgh-and-much-more-SECRET",
        ),
        input_fn=_no_input,
        getpass_fn=_no_input,
        opener=echo,
    )

    assert code == 0
    assert "much-more-SECRET" not in capsys.readouterr().out


def test_ctrl_d_at_the_dash_prompt_exits_2(
    config_path: Path, opener: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sys, "stdin", _Tty(""))

    def eof(prompt: str) -> str:
        raise EOFError

    code = main(
        _setup_args("--no-probe", "--langextract-api-key", "-"),
        input_fn=_no_input,
        getpass_fn=eof,
        opener=opener,
    )

    assert code == 2
    assert not config_path.exists()


def test_dash_with_no_stdin_exits_2(
    config_path: Path, opener: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sys, "stdin", None)

    code = main(
        _setup_args("--no-probe", "--langextract-api-key", "-"),
        input_fn=_no_input,
        getpass_fn=_no_input,
        opener=opener,
    )

    assert code == 2
    assert not config_path.exists()


def test_probe_survives_an_http_error_whose_body_is_closed(
    config_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    def closed(req: Any, timeout: float | None = None) -> None:
        body = io.BytesIO(b"")
        body.close()
        raise urllib.error.HTTPError(req.full_url, 500, "boom", None, body)  # type: ignore[arg-type]

    code = main(_setup_args(), input_fn=_no_input, getpass_fn=_no_input, opener=closed)

    assert code == 0
    assert "HTTP 500" in capsys.readouterr().out


def test_bad_value_in_the_existing_file_exits_2_without_echo(
    config_path: Path, opener: Any, capsys: pytest.CaptureFixture[str]
) -> None:
    config_path.parent.mkdir(parents=True)
    original = b"LANGEXTRACT_MODEL_ID=bad\tmodel-secretish\n"
    config_path.write_bytes(original)

    code = main(_setup_args("--no-probe"), input_fn=_no_input, getpass_fn=_no_input, opener=opener)

    assert code == 2
    err = capsys.readouterr().err
    assert "LANGEXTRACT_MODEL_ID" in err and "secretish" not in err
    assert config_path.read_bytes() == original


def test_gateway_probe_uses_a_key_from_the_environment(
    config_path: Path, calls: list[Any], opener: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("LITELLM_AGENT_KEY", "sk-env-gateway-7777")

    code = main(_setup_args(), input_fn=_no_input, getpass_fn=_no_input, opener=opener)

    assert code == 0
    gateway = [req for req in calls if req.full_url.endswith("/models")]
    assert gateway[0].unredirected_hdrs.get("Authorization") == "Bearer sk-env-gateway-7777"
    crawl = [req for req in calls if req.full_url.endswith("/health")]
    assert "Authorization" not in crawl[0].unredirected_hdrs


def test_plain_http_warning_counts_the_files_litellm_key(
    config_path: Path, opener: Any, capsys: pytest.CaptureFixture[str]
) -> None:
    config_path.parent.mkdir(parents=True)
    config_path.write_text("LITELLM_AGENT_KEY=sk-file-litellm-0000\n")

    code = main(
        [
            "setup",
            "--non-interactive",
            "--no-probe",
            "--crawl4ai-url",
            CRAWL4AI,
            "--langextract-base-url",
            "http://gateway.example.com:4001/v1",
        ],
        input_fn=_no_input,
        getpass_fn=_no_input,
        opener=opener,
    )

    assert code == 0
    gateway_warning = [
        line for line in capsys.readouterr().out.splitlines() if "LANGEXTRACT_BASE_URL" in line
    ]
    assert gateway_warning and "bearer key travels in clear" in gateway_warning[0]


def test_probe_skips_a_url_the_environment_overrides(
    config_path: Path,
    calls: list[Any],
    opener: Any,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    # The environment overrides both URLs: probing the saved URLs would send the environment keys
    # to hosts a live run never uses, and probing the environment URLs would use values setup
    # never validated. So neither is probed; the line names the variable, never its value.
    monkeypatch.setenv("CRAWL4AI_URL", "https://crawl.internal.example")
    monkeypatch.setenv("CRAWL4AI_API_TOKEN", "tok-INTERNAL-only-0001")
    monkeypatch.setenv("LANGEXTRACT_BASE_URL", "https://gw.internal.example/v1")
    monkeypatch.setenv("LITELLM_AGENT_KEY", "sk-INTERNAL-gw-key-0002")

    code = main(
        [
            "setup",
            "--non-interactive",
            "--crawl4ai-url",
            "https://crawl.thirdparty.example",
            "--langextract-base-url",
            "https://api.thirdparty.example/v1",
        ],
        input_fn=_no_input,
        getpass_fn=_no_input,
        opener=opener,
    )

    assert code == 0
    assert calls == []
    out = capsys.readouterr().out
    assert "crawl4ai: skipped" in out and "gateway: skipped" in out
    assert "internal.example" not in out and "INTERNAL" not in out


@pytest.mark.parametrize(
    "name,url",
    [
        ("CRAWL4AI_URL", "crawl4ai"),
        ("CRAWL4AI_URL", "http://[::1"),
        ("LANGEXTRACT_BASE_URL", "https://proxyuser:Proxy-Pass-SECRET-99@gw.invalid/v1"),
    ],
)
def test_an_unvalidated_environment_url_is_never_probed_or_printed(
    config_path: Path,
    calls: list[Any],
    opener: Any,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    name: str,
    url: str,
) -> None:
    monkeypatch.setenv(name, url)

    code = main(_setup_args(), input_fn=_no_input, getpass_fn=_no_input, opener=opener)

    assert code == 0
    assert not any(req.full_url.startswith(url) for req in calls)
    out = capsys.readouterr().out
    # The label "crawl4ai" equals one URL, so look for the URL where a probe line would print it.
    assert f"({url}" not in out and "Proxy-Pass-SECRET-99" not in out
    assert f"skipped ({name} is set in the environment)" in out


def test_probe_prefers_an_environment_key_over_the_saved_one(
    config_path: Path, calls: list[Any], opener: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CRAWL4AI_API_TOKEN", "tok-env-wins-1234")

    code = main(
        _setup_args("--crawl4ai-token", "tok-saved-loses-5678"),
        input_fn=_no_input,
        getpass_fn=_no_input,
        opener=opener,
    )

    assert code == 0
    crawl = [req for req in calls if req.full_url.endswith("/health")]
    assert crawl[0].unredirected_hdrs.get("Authorization") == "Bearer tok-env-wins-1234"


def test_probe_masks_an_environment_secret_the_server_echoes(
    config_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("LITELLM_AGENT_KEY", "sk-env-echoed-secret-4321")

    def echo(req: Any, timeout: float | None = None) -> None:
        raise urllib.error.URLError("bad key sk-env-echoed-secret-4321")

    code = main(_setup_args(), input_fn=_no_input, getpass_fn=_no_input, opener=echo)

    assert code == 0
    assert "sk-env-echoed-secret-4321" not in capsys.readouterr().out


def test_a_padded_saved_url_is_probed_stripped(
    config_path: Path, calls: list[Any], opener: Any, capsys: pytest.CaptureFixture[str]
) -> None:
    config_path.parent.mkdir(parents=True)
    config_path.write_text(
        'CRAWL4AI_URL=" https://crawl.file.example "\nLANGEXTRACT_BASE_URL=' + GATEWAY + "\n"
    )

    code = main(
        ["setup", "--non-interactive"], input_fn=_no_input, getpass_fn=_no_input, opener=opener
    )

    assert code == 0
    assert "skipped" not in capsys.readouterr().out
    assert "https://crawl.file.example/health" in [req.full_url for req in calls]
    assert config.load()["CRAWL4AI_URL"] == "https://crawl.file.example"


@pytest.mark.parametrize(
    "line",
    [
        "CRAWL4AI_URL=https://u:FilePass-SECRET-7@crawl.file.example",
        'CRAWL4AI_URL="http://[::1"',
        "CRAWL4AI_URL=crawl4ai",
    ],
)
def test_an_invalid_value_loaded_from_the_file_exits_2_without_echo(
    config_path: Path,
    calls: list[Any],
    opener: Any,
    capsys: pytest.CaptureFixture[str],
    line: str,
) -> None:
    config_path.parent.mkdir(parents=True)
    original = f"{line}\nLANGEXTRACT_BASE_URL={GATEWAY}\n"
    config_path.write_text(original)

    code = main(
        ["setup", "--non-interactive"], input_fn=_no_input, getpass_fn=_no_input, opener=opener
    )

    assert code == 2
    assert calls == []
    captured = capsys.readouterr()
    assert "CRAWL4AI_URL" in captured.err
    assert "FilePass-SECRET-7" not in captured.out + captured.err
    assert config_path.read_text() == original


def test_saved_url_with_userinfo_is_masked_in_the_prompt_label(
    config_path: Path, opener: Any, capsys: pytest.CaptureFixture[str]
) -> None:
    config_path.parent.mkdir(parents=True)
    config_path.write_text(
        f"CRAWL4AI_URL=http://user:hunter2@crawl.example.com:11235\nLANGEXTRACT_BASE_URL={GATEWAY}\n",
        encoding="utf-8",
    )
    prompts: list[str] = []
    answers = ["", CRAWL4AI]  # keep the bad saved value once, then fix it

    def ask(prompt: str) -> str:
        prompts.append(prompt)
        return answers.pop(0) if answers else ""

    code = main(["setup", "--no-probe"], input_fn=ask, getpass_fn=ask, opener=opener)

    assert code == 0
    assert "CRAWL4AI_URL [http://****@crawl.example.com:11235]: " in prompts
    captured = capsys.readouterr()
    assert "hunter2" not in captured.out + captured.err
    assert config.load()["CRAWL4AI_URL"] == CRAWL4AI


def test_saved_url_with_userinfo_exits_2_naming_the_variable_without_echo(
    config_path: Path, opener: Any, capsys: pytest.CaptureFixture[str]
) -> None:
    config_path.parent.mkdir(parents=True)
    original = f"CRAWL4AI_URL=http://user:hunter2@crawl.example.com:11235\nLANGEXTRACT_BASE_URL={GATEWAY}\n"
    config_path.write_text(original, encoding="utf-8")

    code = main(
        ["setup", "--non-interactive", "--no-probe"],
        input_fn=_no_input,
        getpass_fn=_no_input,
        opener=opener,
    )

    assert code == 2
    captured = capsys.readouterr()
    assert "CRAWL4AI_URL" in captured.err
    assert "hunter2" not in captured.out + captured.err
    assert config_path.read_text(encoding="utf-8") == original


def test_redirect_host_is_masked_whatever_its_case(
    config_path: Path, opener: Any, capsys: pytest.CaptureFixture[str]
) -> None:
    def redirect(req: Any, timeout: float | None = None) -> None:
        raise urllib.error.HTTPError(
            req.full_url,
            302,
            "Found",
            {"Location": "http://sk-gateway-5678.elsewhere.test/v1/models"},
            io.BytesIO(b""),
        )

    code = main(
        [
            "setup",
            "--non-interactive",
            "--crawl4ai-url",
            CRAWL4AI,
            "--langextract-base-url",
            GATEWAY,
            "--langextract-api-key",
            "SK-Gateway-5678",
        ],
        input_fn=_no_input,
        getpass_fn=_no_input,
        opener=redirect,
    )

    assert code == 0
    out = capsys.readouterr().out
    assert "FAIL" in out and "redirected" in out
    assert "sk-gateway-5678" not in out.lower()


def test_env_secret_with_a_tab_is_masked_raw_and_escaped(
    config_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    secret = "sk-tab\tsecret-99"
    monkeypatch.setenv("LANGEXTRACT_API_KEY", secret)

    def echo(req: Any, timeout: float | None = None) -> None:
        raise http.client.BadStatusLine(secret)

    code = main(_setup_args(), input_fn=_no_input, getpass_fn=_no_input, opener=echo)

    assert code == 0
    out = capsys.readouterr().out
    assert "FAIL" in out
    assert "secret-99" not in out


@pytest.mark.parametrize("url", ["http://bad host:11235", "http://bad\thost:11235"])
def test_whitespace_in_the_host_exits_2_naming_the_variable(
    config_path: Path, opener: Any, capsys: pytest.CaptureFixture[str], url: str
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

    assert code == 2
    assert not config_path.exists()
    assert "CRAWL4AI_URL" in capsys.readouterr().err


@pytest.mark.parametrize("stdin_text", ["\n" * 10, ""], ids=["empty-lines", "empty-stream"])
def test_required_prompt_gives_up_on_a_non_tty_stdin(
    config_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    stdin_text: str,
) -> None:
    monkeypatch.setattr(sys, "stdin", io.StringIO(stdin_text))

    code = main(["setup", "--no-probe"], getpass_fn=_no_input, opener=_no_input)

    assert code == 2
    assert not config_path.exists()
    assert "CRAWL4AI_URL" in capsys.readouterr().err


def test_every_bad_flag_is_reported_in_one_run(
    config_path: Path, opener: Any, capsys: pytest.CaptureFixture[str]
) -> None:
    code = main(
        [
            "setup",
            "--non-interactive",
            "--no-probe",
            "--crawl4ai-url",
            "ftp://crawl.example.com/",
            "--langextract-base-url",
            "gateway.example.com:4001/v1",
        ],
        input_fn=_no_input,
        getpass_fn=_no_input,
        opener=opener,
    )

    assert code == 2
    assert not config_path.exists()
    err = capsys.readouterr().err
    assert "CRAWL4AI_URL" in err and "LANGEXTRACT_BASE_URL" in err


def test_empty_optional_flag_clears_the_saved_key(config_path: Path, opener: Any) -> None:
    config.save(
        {
            "CRAWL4AI_URL": CRAWL4AI,
            "LANGEXTRACT_BASE_URL": GATEWAY,
            "CRAWL4AI_API_TOKEN": "tok-old-1234",
            "LANGEXTRACT_MODEL_ID": "openai/gpt-4o",
        }
    )

    code = main(
        [
            "setup",
            "--non-interactive",
            "--no-probe",
            "--crawl4ai-token",
            "",
            "--langextract-model-id",
            "",
        ],
        input_fn=_no_input,
        getpass_fn=_no_input,
        opener=opener,
    )

    assert code == 0
    assert config.load() == {"CRAWL4AI_URL": CRAWL4AI, "LANGEXTRACT_BASE_URL": GATEWAY}


def test_empty_required_flag_exits_2_and_keeps_the_file(
    config_path: Path, opener: Any, capsys: pytest.CaptureFixture[str]
) -> None:
    config.save({"CRAWL4AI_URL": CRAWL4AI, "LANGEXTRACT_BASE_URL": GATEWAY})
    original = config_path.read_bytes()

    code = main(
        [
            "setup",
            "--non-interactive",
            "--no-probe",
            "--crawl4ai-url",
            "",
        ],
        input_fn=_no_input,
        getpass_fn=_no_input,
        opener=opener,
    )

    assert code == 2
    assert "CRAWL4AI_URL" in capsys.readouterr().err
    assert config_path.read_bytes() == original


def test_resave_keeps_comments_and_unknown_keys_in_their_places(
    config_path: Path, opener: Any
) -> None:
    config_path.parent.mkdir(parents=True)
    config_path.write_text(
        "# set up by hand\nCUSTOM_NOTE=keep-me\nCRAWL4AI_URL=http://old.example.com:11235\n",
        encoding="utf-8",
    )

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
    assert config_path.read_text(encoding="utf-8").splitlines() == [
        "# set up by hand",
        "CUSTOM_NOTE=keep-me",
        f"CRAWL4AI_URL={CRAWL4AI}",
        f"LANGEXTRACT_BASE_URL={GATEWAY}",
    ]
