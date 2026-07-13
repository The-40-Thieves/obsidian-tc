"""Wire contracts for the aligned /v1/encode surface (dense+sparse+ColBERT in one response)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Output = Literal["dense", "sparse", "colbert"]


class EncodeRequest(BaseModel):
    model: str | None = None
    input: list[str] = Field(min_length=1)
    outputs: list[Output] = Field(default_factory=lambda: ["sparse", "colbert"])


class SparseVec(BaseModel):
    # token ids and their learned weights are returned TOGETHER, so the caller never
    # reconstructs alignment from separate /pooling + /tokenize responses.
    token_ids: list[int]
    weights: list[float]


class ColbertVec(BaseModel):
    vectors: list[list[float]]


class EncodeItem(BaseModel):
    dense: list[float] | None = None
    sparse: SparseVec | None = None
    colbert: ColbertVec | None = None


class EncodeResponse(BaseModel):
    model: str
    revision: str
    items: list[EncodeItem]


class ModelInfo(BaseModel):
    id: str
    revision: str
    device: str
    max_length: int
    ready: bool


class HealthStatus(BaseModel):
    status: str
    detail: str | None = None
