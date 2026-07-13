"""load_settings: defaults + environment overrides (no model deps)."""

from __future__ import annotations

import importlib


def _reload_config():
    import obsidian_tc_bge.config as cfg

    return importlib.reload(cfg)


def test_defaults(monkeypatch):
    for k in list(__import__("os").environ):
        if k.startswith("BGE_"):
            monkeypatch.delenv(k, raising=False)
    cfg = _reload_config()
    s = cfg.load_settings()
    assert s.model_id == "BAAI/bge-m3"
    assert s.model_revision == "main"
    assert s.host == "127.0.0.1"
    assert s.port == 8002
    assert s.auth_token == ""
    assert s.device == "auto"
    assert s.max_request_items == 256
    assert s.reranker_model_id == "BAAI/bge-reranker-v2-m3"
    assert s.reranker_max_length == 512
    assert s.max_rerank_documents == 512


def test_env_overrides(monkeypatch):
    monkeypatch.setenv("BGE_MODEL_ID", "BAAI/other")
    monkeypatch.setenv("BGE_PORT", "9100")
    monkeypatch.setenv("BGE_AUTH_TOKEN", "secret")
    monkeypatch.setenv("BGE_FP16", "0")
    monkeypatch.setenv("BGE_RERANKER_REVISION", "abc123")
    monkeypatch.setenv("BGE_MAX_RERANK_DOCUMENTS", "16")
    cfg = _reload_config()
    s = cfg.load_settings()
    assert s.model_id == "BAAI/other"
    assert s.port == 9100
    assert s.auth_token == "secret"
    assert s.use_fp16 is False
    assert s.reranker_revision == "abc123"
    assert s.max_rerank_documents == 16
