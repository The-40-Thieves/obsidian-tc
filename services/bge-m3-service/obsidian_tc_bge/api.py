"""FastAPI surface: /health/live, /health/ready, /v1/models, /v1/encode. Loopback + bearer only."""

from __future__ import annotations

import asyncio
import hmac
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Header, HTTPException

from .batching import OverloadError, Scheduler
from .config import load_settings
from .contracts import (
    EncodeRequest,
    EncodeResponse,
    HealthStatus,
    ModelInfo,
    RerankHit,
    RerankRequest,
    RerankResponse,
)
from .health import Readiness
from .model import BgeM3Encoder
from .reranker import BgeReranker

settings = load_settings()
readiness = Readiness()
_state: dict[str, object] = {"encoder": None, "scheduler": None, "reranker": None}
_reranker_lock = asyncio.Lock()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    loop = asyncio.get_running_loop()

    def _load() -> BgeM3Encoder:
        return BgeM3Encoder(
            settings.model_id,
            settings.model_revision,
            settings.device,
            settings.use_fp16,
            settings.max_length,
        )

    try:
        encoder = await loop.run_in_executor(None, _load)
        _state["encoder"] = encoder
        _state["scheduler"] = Scheduler(encoder, settings.max_concurrent)
        readiness.mark_ready()
    except Exception as exc:  # noqa: BLE001 - surface load failure via readiness, never crash the process
        readiness.mark_error(str(exc))
    yield


app = FastAPI(title="obsidian-tc bge-m3-service", version="0.1.0", lifespan=lifespan)


def require_auth(authorization: str | None = Header(default=None)) -> None:
    if not settings.auth_token:
        raise HTTPException(status_code=503, detail="service auth token not configured")
    # Constant-time comparison: a plain `!=` on the bearer string leaks, via response timing, how
    # many leading bytes matched, letting an attacker recover the token byte-by-byte. compare_digest
    # is short-circuit-free. Guard the None header first (compare_digest requires a str).
    expected = f"Bearer {settings.auth_token}"
    if authorization is None or not hmac.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="unauthorized")


@app.get("/health/live", response_model=HealthStatus)
async def live() -> HealthStatus:
    return HealthStatus(status="ok")


@app.get("/health/ready", response_model=HealthStatus)
async def ready() -> HealthStatus:
    if not readiness.ready:
        raise HTTPException(status_code=503, detail=readiness.error or "model loading")
    return HealthStatus(status="ready")


@app.get("/v1/models", response_model=ModelInfo, dependencies=[Depends(require_auth)])
async def models() -> ModelInfo:
    encoder = _state["encoder"]
    return ModelInfo(
        id=settings.model_id,
        revision=getattr(encoder, "revision", settings.model_revision),
        device=getattr(encoder, "device", settings.device),
        max_length=settings.max_length,
        ready=readiness.ready,
    )


@app.post("/v1/encode", response_model=EncodeResponse, dependencies=[Depends(require_auth)])
async def encode(req: EncodeRequest) -> EncodeResponse:
    if not readiness.ready:
        raise HTTPException(status_code=503, detail=readiness.error or "model not ready")
    if len(req.input) > settings.max_request_items:
        raise HTTPException(status_code=413, detail=f"too many items (max {settings.max_request_items})")
    if any(len(t) > settings.max_text_chars for t in req.input):
        raise HTTPException(status_code=413, detail="input text too long")
    scheduler: Scheduler = _state["scheduler"]  # type: ignore[assignment]
    encoder: BgeM3Encoder = _state["encoder"]  # type: ignore[assignment]
    try:
        items = await scheduler.encode(req.input, req.outputs)
    except OverloadError as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    return EncodeResponse(model=settings.model_id, revision=encoder.revision, items=items)


def _load_reranker() -> BgeReranker:
    encoder: BgeM3Encoder = _state["encoder"]  # type: ignore[assignment]
    return BgeReranker(
        settings.reranker_model_id,
        settings.reranker_revision,
        getattr(encoder, "device", "cpu"),
        settings.reranker_max_length,
    )


async def _reranker() -> BgeReranker:
    if _state.get("reranker") is None:
        async with _reranker_lock:
            if _state.get("reranker") is None:
                loop = asyncio.get_running_loop()
                _state["reranker"] = await loop.run_in_executor(None, _load_reranker)
    return _state["reranker"]  # type: ignore[return-value]


@app.post("/v1/rerank", response_model=RerankResponse, dependencies=[Depends(require_auth)])
async def rerank(req: RerankRequest) -> RerankResponse:
    if not readiness.ready:
        raise HTTPException(status_code=503, detail=readiness.error or "model not ready")
    if len(req.documents) > settings.max_rerank_documents:
        raise HTTPException(
            status_code=413, detail=f"too many documents (max {settings.max_rerank_documents})"
        )
    scheduler: Scheduler = _state["scheduler"]  # type: ignore[assignment]
    reranker = await _reranker()
    try:
        ranked = await scheduler.run(reranker.rerank, req.query, req.documents, req.top_n)
    except OverloadError as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    return RerankResponse(
        model=settings.reranker_model_id,
        revision=reranker.revision,
        results=[RerankHit(index=i, relevance_score=s) for i, s in ranked],
    )
