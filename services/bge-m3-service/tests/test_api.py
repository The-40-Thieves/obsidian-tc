"""FastAPI surface with the model layer stubbed out (no torch / FlagEmbedding needed).

The heavy imports (torch, FlagEmbedding, sentence-transformers) live inside BgeM3Encoder /
BgeReranker methods, so replacing those classes in the api module lets the app boot and serve
without any model weights. TestClient as a context manager runs the lifespan, which builds the
stub encoder + scheduler and marks readiness ready."""

from __future__ import annotations

from fastapi.testclient import TestClient

import obsidian_tc_bge.api as api
from obsidian_tc_bge.config import Settings
from obsidian_tc_bge.contracts import EncodeItem, SparseVec


class StubEncoder:
    revision = "stub-rev"
    device = "cpu"

    def __init__(self, *_args, **_kwargs):
        pass

    def encode(self, texts, outputs):
        return [
            EncodeItem(
                dense=[0.1, 0.2] if "dense" in outputs else None,
                sparse=SparseVec(token_ids=[1], weights=[0.5]) if "sparse" in outputs else None,
                colbert=None,
            )
            for _ in texts
        ]


class StubReranker:
    revision = "rr-rev"

    def __init__(self, *_args, **_kwargs):
        pass

    def rerank(self, query, documents, top_n=None):
        pairs = [(i, 1.0 - i * 0.1) for i in range(len(documents))]
        return pairs[:top_n] if top_n else pairs


def _settings(token="tok", max_items=256, max_docs=256):
    return Settings(
        model_id="BAAI/bge-m3",
        model_revision="main",
        host="127.0.0.1",
        port=8002,
        auth_token=token,
        device="cpu",
        use_fp16=False,
        max_length=8192,
        max_concurrent=4,
        max_request_items=max_items,
        max_text_chars=100000,
        reranker_model_id="BAAI/bge-reranker-v2-m3",
        reranker_revision="main",
        reranker_max_length=512,
        max_rerank_documents=max_docs,
    )


def _client(monkeypatch, **kw):
    monkeypatch.setattr(api, "settings", _settings(**kw))
    monkeypatch.setattr(api, "BgeM3Encoder", StubEncoder)
    monkeypatch.setattr(api, "BgeReranker", StubReranker)
    return TestClient(api.app)


def test_live(monkeypatch):
    with _client(monkeypatch) as c:
        r = c.get("/health/live")
        assert r.status_code == 200
        assert r.json()["status"] == "ok"


def test_ready_after_stub_load(monkeypatch):
    with _client(monkeypatch) as c:
        assert c.get("/health/ready").status_code == 200


def test_encode_requires_auth(monkeypatch):
    with _client(monkeypatch) as c:
        r = c.post("/v1/encode", json={"input": ["hi"], "outputs": ["dense"]})
        assert r.status_code == 401


def test_encode_ok(monkeypatch):
    with _client(monkeypatch) as c:
        r = c.post(
            "/v1/encode",
            headers={"authorization": "Bearer tok"},
            json={"input": ["hi"], "outputs": ["dense", "sparse"]},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["model"] == "BAAI/bge-m3"
        assert len(body["items"]) == 1
        assert body["items"][0]["dense"] == [0.1, 0.2]


def test_encode_413_too_many_items(monkeypatch):
    with _client(monkeypatch, max_items=2) as c:
        r = c.post(
            "/v1/encode",
            headers={"authorization": "Bearer tok"},
            json={"input": ["a", "b", "c"], "outputs": ["dense"]},
        )
        assert r.status_code == 413


def test_rerank_ok(monkeypatch):
    with _client(monkeypatch) as c:
        r = c.post(
            "/v1/rerank",
            headers={"authorization": "Bearer tok"},
            json={"query": "q", "documents": ["a", "b"], "top_n": 2},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["model"] == "BAAI/bge-reranker-v2-m3"
        assert body["results"][0] == {"index": 0, "relevance_score": 1.0}


def test_rerank_413_too_many_docs(monkeypatch):
    with _client(monkeypatch, max_docs=1) as c:
        r = c.post(
            "/v1/rerank",
            headers={"authorization": "Bearer tok"},
            json={"query": "q", "documents": ["a", "b"]},
        )
        assert r.status_code == 413
