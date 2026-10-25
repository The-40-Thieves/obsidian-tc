"""Live settings reach the requests: the crawl4ai token and the gateway key come from the setup
file when the environment does not set them, and a redirect never carries them to another host."""

from __future__ import annotations

import json
import sys
import types
import urllib.error
from pathlib import Path
from typing import Any

import pytest

from obsidian_tc_docs_ingest import config, pipeline
from obsidian_tc_docs_ingest.contracts import SourceRef

SOURCE = SourceRef(uri="https://docs.example.com/x")
RENDER = json.dumps({"results": [{"success": True, "markdown": "# Hi"}]}).encode()
SETTINGS = (
    "CRAWL4AI_URL",
    "CRAWL4AI_API_TOKEN",
    "LANGEXTRACT_BASE_URL",
    "LANGEXTRACT_API_KEY",
    "LITELLM_AGENT_KEY",
    "LANGEXTRACT_MODEL_ID",
)


def _setup_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, values: dict[str, str]) -> None:
    monkeypatch.setenv("DOCS_INGEST_CONFIG", str(tmp_path / "docs-ingest.env"))
    config.save(values)
    for name in SETTINGS:
        monkeypatch.delenv(name, raising=False)


def _fake_langextract(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Stand in for the langextract package and record what ``_call_langextract`` passes it."""
    captured: dict[str, Any] = {}
    lx = types.ModuleType("langextract")
    lx.data = types.SimpleNamespace(ExampleData=dict, Extraction=dict)  # type: ignore[attr-defined]

    def extract(**kwargs: Any) -> None:
        captured.update(kwargs)

    lx.extract = extract  # type: ignore[attr-defined]
    factory = types.ModuleType("langextract.factory")
    factory.ModelConfig = lambda **kwargs: kwargs  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "langextract", lx)
    monkeypatch.setitem(sys.modules, "langextract.factory", factory)
    return captured


def test_crawl4ai_token_from_the_setup_file_reaches_the_request(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, local_http: Any
) -> None:
    crawl = local_http(body=RENDER)
    _setup_file(
        tmp_path,
        monkeypatch,
        {
            "CRAWL4AI_URL": f"http://127.0.0.1:{crawl.server_port}",
            "CRAWL4AI_API_TOKEN": "tok-from-file",
        },
    )

    result = pipeline._parse_crawl4ai(SOURCE)

    assert result.markdown == "# Hi"
    assert crawl.seen[0][2] == "Bearer tok-from-file"


def test_crawl4ai_redirect_is_not_followed_so_the_token_stays_with_the_origin(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, local_http: Any
) -> None:
    other = local_http(body=RENDER)
    origin = local_http(status=302, location=f"http://127.0.0.1:{other.server_port}/elsewhere")
    _setup_file(
        tmp_path,
        monkeypatch,
        {
            "CRAWL4AI_URL": f"http://127.0.0.1:{origin.server_port}",
            "CRAWL4AI_API_TOKEN": "tok-from-file",
        },
    )

    with pytest.raises(urllib.error.HTTPError):
        pipeline._parse_crawl4ai(SOURCE)

    assert other.seen == []
    assert origin.seen[0][2] == "Bearer tok-from-file"


def test_langextract_key_prefers_the_environment_over_a_stale_file_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _setup_file(
        tmp_path,
        monkeypatch,
        {
            "LANGEXTRACT_BASE_URL": "https://gateway.example.com/v1",
            "LANGEXTRACT_API_KEY": "stale-file-key",
        },
    )
    monkeypatch.setenv("LITELLM_AGENT_KEY", "fresh-env-key")
    captured = _fake_langextract(monkeypatch)

    pipeline._call_langextract("text")

    assert captured["config"]["provider_kwargs"]["api_key"] == "fresh-env-key"
    assert captured["config"]["provider_kwargs"]["base_url"] == "https://gateway.example.com/v1"


def test_langextract_key_from_the_file_alone_reaches_the_model(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _setup_file(
        tmp_path,
        monkeypatch,
        {
            "LANGEXTRACT_BASE_URL": "https://gateway.example.com/v1",
            "LANGEXTRACT_API_KEY": "file-key",
        },
    )
    captured = _fake_langextract(monkeypatch)

    pipeline._call_langextract("text")

    assert captured["config"]["provider_kwargs"]["api_key"] == "file-key"
