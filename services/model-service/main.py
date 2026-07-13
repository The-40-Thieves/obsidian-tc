"""Local GPU model service for obsidian-tc — CORRECT per-model serving behind the gateway boundary.

Fixes the measurement-validity problem behind the wave-7 verdicts:
  * qwen3-embedding needs LAST-TOKEN pooling (the generic Ollama/vLLM path used mean pooling);
  * bge-m3 needs FlagEmbedding for dense + sparse + colbert (vLLM/TEI cannot serve sparse/colbert).

Speaks the exact contracts obsidian-tc already expects (embeddings/providers.ts, bge-m3.ts,
gateway/client.ts), so no new TS provider is needed for the OpenAI path:
  POST /v1/embeddings  {model, input:[...]} -> {data:[{embedding:[...]}]}       (OpenAI-style)
  POST /pooling        {model, input:[...], task} -> {data:[...]}               (bge-m3 sparse/colbert)
  POST /tokenize       {model, prompt} -> {tokens:[...]}                        (bge-m3 sparse pairing)
  POST /rerank         {model, query, documents, top_n}
                        -> {model, results:[{index, relevance_score}]}          (cross-encoder)
  GET  /health

One model resides in VRAM at a time (10 GB RTX 3080): a new model request evicts the previous.
The qwen3 `Instruct: ...` query prompt is applied by obsidian-tc's queryPrefix seam (query-time
only), so this service does only the model-correct POOLING here — no double-instruct.

Run:  uv run uvicorn main:app --host 127.0.0.1 --port 8000
"""

from __future__ import annotations

import gc
from typing import Any, Callable, Literal, Optional

import torch
from fastapi import FastAPI
from pydantic import BaseModel

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
app = FastAPI(title="obsidian-tc model service")

# ---- single-model VRAM cache (evict-on-switch to fit 10 GB) ----
_loaded: dict[str, Any] = {"key": None, "obj": None}


def _evict() -> None:
    if _loaded["obj"] is not None:
        _loaded["obj"] = None
        _loaded["key"] = None
        gc.collect()
        if DEVICE == "cuda":
            torch.cuda.empty_cache()


def _get(key: str, loader: Callable[[], Any]) -> Any:
    if _loaded["key"] != key:
        _evict()
        _loaded["obj"] = loader()
        _loaded["key"] = key
    return _loaded["obj"]


def _st(model_id: str) -> Any:
    from sentence_transformers import SentenceTransformer

    return _get(
        f"st:{model_id}",
        lambda: SentenceTransformer(model_id, device=DEVICE, trust_remote_code=True),
    )


def _bge_m3(model_id: str = "BAAI/bge-m3") -> Any:
    from FlagEmbedding import BGEM3FlagModel

    return _get(f"bge-m3:{model_id}", lambda: BGEM3FlagModel(model_id, use_fp16=True))


def _reranker(model_id: str) -> Any:
    # CrossEncoder (sentence-transformers) rather than FlagReranker: the latter trips
    # `XLMRobertaTokenizer has no attribute prepare_for_model` on the slow tokenizer.
    from sentence_transformers import CrossEncoder

    return _get(
        f"rr:{model_id}",
        lambda: CrossEncoder(
            model_id, device=DEVICE, max_length=512, trust_remote_code=True
        ),
    )


def _resolve(model: str) -> tuple[str, str]:
    """Map a caller model alias -> (HF id, family)."""
    m = model.lower()
    if "qwen3" in m:
        size = "4B"
        if "0.6" in m or "0_6" in m:
            size = "0.6B"
        elif "8b" in m:
            size = "8B"
        return (f"Qwen/Qwen3-Embedding-{size}", "qwen3")
    if "bge-m3" in m:
        return ("BAAI/bge-m3", "bge-m3")
    if "rerank" in m:
        return ("BAAI/bge-reranker-v2-m3", "reranker")
    return (model, "st")


class EmbeddingsReq(BaseModel):
    model: str
    input: list[str] | str


@app.post("/v1/embeddings")
def embeddings(req: EmbeddingsReq) -> dict:
    texts = [req.input] if isinstance(req.input, str) else list(req.input)
    hf_id, fam = _resolve(req.model)
    if fam == "bge-m3":
        out = _bge_m3(hf_id).encode(
            texts,
            batch_size=12,
            max_length=8192,
            return_dense=True,
            return_sparse=False,
            return_colbert_vecs=False,
        )
        vecs = [v.tolist() for v in out["dense_vecs"]]
    else:
        # qwen3 (last-token pooling native to the model config) or any sentence-transformers id.
        vecs = _st(hf_id).encode(
            texts, batch_size=12, normalize_embeddings=True, convert_to_numpy=True
        )
        vecs = [v.tolist() for v in vecs]
    data = [
        {"object": "embedding", "index": i, "embedding": v} for i, v in enumerate(vecs)
    ]
    return {"object": "list", "model": req.model, "data": data}


class PoolingReq(BaseModel):
    model: str
    input: list[str]
    task: Literal["token_classify", "token_embed"]


@app.post("/pooling")
def pooling(req: PoolingReq) -> dict:
    m = _bge_m3()
    if (
        req.task == "token_classify"
    ):  # sparse: per-token weights aligned to /tokenize output
        out = m.encode(
            req.input, return_dense=False, return_sparse=True, return_colbert_vecs=False
        )
        tok = m.tokenizer
        data = []
        for i, text in enumerate(req.input):
            ids = tok(text)["input_ids"]
            lw = out["lexical_weights"][i]
            # obsidian-tc pairs these position-wise with /tokenize; specials (weight 0) get dropped.
            weights = [float(lw.get(t, lw.get(str(t), 0.0))) for t in ids]
            data.append({"index": i, "data": weights})
        return {"data": data}
    out = m.encode(
        req.input, return_dense=False, return_sparse=False, return_colbert_vecs=True
    )  # colbert
    return {
        "data": [
            {"index": i, "colbert_vecs": cv.tolist()}
            for i, cv in enumerate(out["colbert_vecs"])
        ]
    }


class TokenizeReq(BaseModel):
    model: str
    prompt: str


@app.post("/tokenize")
def tokenize(req: TokenizeReq) -> dict:
    # obsidian-tc expects token IDs as a flat number[] (bge-m3.ts pairSparse aligns them to /pooling).
    tok = _bge_m3().tokenizer
    ids = tok(req.prompt)["input_ids"]
    return {"tokens": [int(i) for i in ids]}


class RerankReq(BaseModel):
    model: str
    query: str
    documents: list[str]
    top_n: Optional[int] = None


@app.post("/rerank")
def rerank(req: RerankReq) -> dict:
    import numpy as np

    rr = _reranker("BAAI/bge-reranker-v2-m3")
    pairs = [[req.query, d] for d in req.documents]
    logits = np.asarray(rr.predict(pairs), dtype=float).reshape(-1)
    scores = (1.0 / (1.0 + np.exp(-logits))).tolist()  # sigmoid -> [0, 1]
    ranked = sorted(enumerate(scores), key=lambda x: x[1], reverse=True)
    if req.top_n:
        ranked = ranked[: req.top_n]
    return {
        "model": req.model,
        "results": [{"index": i, "relevance_score": float(s)} for i, s in ranked],
    }


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "device": DEVICE,
        "cuda": torch.cuda.get_device_name(0) if DEVICE == "cuda" else None,
        "loaded": _loaded["key"],
    }
