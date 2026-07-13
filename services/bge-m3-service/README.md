# bge-m3-service

The Python **BGE-M3 multi-vector** backend behind the TypeScript `ModelClient` seam
(`packages/server/src/model/ports.ts`). It serves the three heads BGE-M3 produces - a dense `[CLS]`
vector, learned-sparse lexical weights, and a ColBERT per-token matrix - from **one** `/v1/encode`
call, aligned in a single response. The TS adapter is `packages/server/src/model/bge.ts`; the
composition root `packages/server/src/model/compose.ts` routes `embedFull()` here while the
**required dense stream** (Qwen3) is served separately by the Rust TEI service (`services/qwen-tei`).
These are **separate retrieval streams** (different vector spaces), fused downstream by RRF on ranks -
never by adding a Qwen cosine to a BGE score.

Why a coarse in-process service and not a live per-batch sidecar: the boundary is deliberately
**large and stable** - one model, one process, batched requests - so the ML/Python cost (packaging,
CUDA, FlagEmbedding) is paid once behind a stable contract, not re-paid per chatty call.

## Contract

`POST /v1/encode` - the only inference endpoint. Request:

    { "input": ["text one", "text two"], "outputs": ["dense", "sparse", "colbert"] }

`outputs` selects which heads to compute (default `["sparse","colbert"]`; ask for `"dense"` too for
the eval-only dense A/B). Response - one aligned item per input, **token ids and their weights
returned together** so the caller never realigns a separate `/pooling` + `/tokenize` round-trip:

    {
      "model": "BAAI/bge-m3",
      "revision": "<commit-sha>",
      "items": [
        {
          "dense": [0.01, -0.02, "...1024 floats"],
          "sparse": { "token_ids": [101, 250], "weights": [0.71, 0.30] },
          "colbert": { "vectors": [[0.0, "..."], ["..."]] }
        }
      ]
    }

Health & metadata:

- `GET /health/live` - process is up (liveness). Always `200` once the server accepts connections.
- `GET /health/ready` - model is loaded (readiness). `503` until weights finish loading, or on load
  failure. Liveness and readiness are **separate signals** so an orchestrator never kills a pod that
  is merely still loading a multi-GB model.
- `GET /v1/models` - resolved model id, revision, device, max length.

`/v1/encode` and `/v1/models` require `Authorization: Bearer $BGE_AUTH_TOKEN`. The service binds to
loopback by default; the bearer token is defence-in-depth, not the only control.

## Safety properties (by design)

- **Bearer auth on 127.0.0.1** - loopback bind + required token; no unauthenticated inference.
- **Revision pinning** - `BGE_MODEL_REVISION` should be an immutable commit sha in production; a
  silent upstream model update thus cannot change your vectors without a config change.
- **No `trust_remote_code`** - the model loads with stock transformers code only.
- **Bounded queue + single-worker batch scheduler** - one model call at a time (the GPU model is not
  re-entrant; interleaving thrashes it), with concurrent in-flight requests capped. Past the cap the
  service returns `429` instead of growing an unbounded queue.
- **Request-size limits** - too many items or an over-long text returns `413`, never an OOM.

## Reranking

`POST /v1/rerank` - cross-encoder rerank via **bge-reranker-v2-m3**, loaded lazily on first call
(a separate model from the bge-m3 encoder, so a dense/encode-only deployment never pays its VRAM).
Request `{ "query": "...", "documents": ["...", "..."], "top_n": 10 }`; response
`{ "model", "revision", "results": [{ "index", "relevance_score" }] }` sorted by descending
relevance (sigmoid of the cross-encoder logit). Gated through the same single-worker scheduler as
encode (the GPU is not re-entrant); a `413` past `BGE_MAX_RERANK_DOCUMENTS`. Env vars:
`BGE_RERANKER_MODEL_ID` (default `BAAI/bge-reranker-v2-m3`), `BGE_RERANKER_REVISION`,
`BGE_RERANKER_MAX_LENGTH` (512), `BGE_MAX_RERANK_DOCUMENTS` (512). The TS `bgeModelClient.rerank`
adapter speaks this, and `composeModelClient` routes `ModelClient.rerank` to it.

## Configuration (environment)

| Var | Default | Meaning |
| --- | --- | --- |
| `BGE_MODEL_ID` | `BAAI/bge-m3` | Model to serve. |
| `BGE_MODEL_REVISION` | `main` | Pin to a commit sha in production. |
| `BGE_HOST` | `127.0.0.1` | Bind address (keep loopback). |
| `BGE_PORT` | `8002` | Port. |
| `BGE_AUTH_TOKEN` | *(empty)* | Bearer token; required for `/v1/encode`. Unset means `/v1/encode` is 503. |
| `BGE_DEVICE` | `auto` | `auto` picks CUDA if available else CPU; or `cuda` / `cpu`. |
| `BGE_FP16` | `1` | Use fp16 on CUDA (ignored on CPU). |
| `BGE_MAX_LENGTH` | `8192` | Max tokens per input. |
| `BGE_MAX_CONCURRENT` | `32` | In-flight cap before `429`. |
| `BGE_MAX_REQUEST_ITEMS` | `256` | Items per request before `413`. |
| `BGE_MAX_TEXT_CHARS` | `100000` | Chars per input before `413`. |

## Run

    cd services/bge-m3-service
    python -m venv .venv && . .venv/Scripts/activate    # POSIX: . .venv/bin/activate
    pip install -e .
    BGE_AUTH_TOKEN=$(openssl rand -hex 16) \
      python -m uvicorn obsidian_tc_bge.api:app --host 127.0.0.1 --port 8002

CPU works for correctness and the eval; a CUDA GPU (fp16) is the throughput path. This is a separate
project from the Bun workspace - the server runs without it, and `embedFull()` is simply absent when
the service is not configured.
