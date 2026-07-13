"""Runtime configuration, resolved once from the environment (no secrets in code)."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    model_id: str
    model_revision: str
    host: str
    port: int
    auth_token: str
    device: str
    use_fp16: bool
    max_length: int
    max_concurrent: int
    max_request_items: int
    max_text_chars: int
    reranker_model_id: str
    reranker_revision: str
    reranker_max_length: int
    max_rerank_documents: int


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    return int(raw) if raw else default


def load_settings() -> Settings:
    return Settings(
        model_id=os.environ.get("BGE_MODEL_ID", "BAAI/bge-m3"),
        # Pin to an immutable commit sha in production; "main" is a dev default.
        model_revision=os.environ.get("BGE_MODEL_REVISION", "main"),
        host=os.environ.get("BGE_HOST", "127.0.0.1"),
        port=_env_int("BGE_PORT", 8002),
        auth_token=os.environ.get("BGE_AUTH_TOKEN", ""),
        device=os.environ.get("BGE_DEVICE", "auto"),
        use_fp16=os.environ.get("BGE_FP16", "1") == "1",
        max_length=_env_int("BGE_MAX_LENGTH", 8192),
        max_concurrent=_env_int("BGE_MAX_CONCURRENT", 32),
        max_request_items=_env_int("BGE_MAX_REQUEST_ITEMS", 256),
        max_text_chars=_env_int("BGE_MAX_TEXT_CHARS", 100000),
        reranker_model_id=os.environ.get("BGE_RERANKER_MODEL_ID", "BAAI/bge-reranker-v2-m3"),
        reranker_revision=os.environ.get("BGE_RERANKER_REVISION", "main"),
        reranker_max_length=_env_int("BGE_RERANKER_MAX_LENGTH", 512),
        max_rerank_documents=_env_int("BGE_MAX_RERANK_DOCUMENTS", 512),
    )
