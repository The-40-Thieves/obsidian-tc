"""Bounded queue + single model worker - no thrash, no unbounded growth, reject overload."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .contracts import EncodeItem, Output
    from .model import BgeM3Encoder


class OverloadError(RuntimeError):
    pass


class Scheduler:
    """Serializes model access (one call at a time) and caps concurrent in-flight requests.

    The GPU model is not re-entrant, and interleaving embed/rerank/colbert calls thrashes it, so
    a single semaphore gates the model while a counter rejects work past the queue ceiling.
    """

    def __init__(self, encoder: BgeM3Encoder, max_concurrent: int) -> None:
        self._encoder = encoder
        self._max = max_concurrent
        self._inflight = 0
        self._gate = asyncio.Semaphore(1)

    async def encode(self, texts: list[str], outputs: list[Output]) -> list[EncodeItem]:
        if self._inflight >= self._max:
            raise OverloadError(f"queue full ({self._inflight}/{self._max})")
        self._inflight += 1
        try:
            async with self._gate:
                loop = asyncio.get_running_loop()
                return await loop.run_in_executor(None, self._encoder.encode, texts, outputs)
        finally:
            self._inflight -= 1

    async def run(self, fn, *args):
        # Gate an arbitrary blocking model call (e.g. the reranker) through the same
        # single-worker semaphore + inflight cap, so encode and rerank never contend on the GPU.
        if self._inflight >= self._max:
            raise OverloadError(f"queue full ({self._inflight}/{self._max})")
        self._inflight += 1
        try:
            async with self._gate:
                loop = asyncio.get_running_loop()
                return await loop.run_in_executor(None, lambda: fn(*args))
        finally:
            self._inflight -= 1
