"""Wire-contract validation (pydantic only, no model deps)."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from obsidian_tc_bge.contracts import EncodeRequest, RerankRequest


def test_encode_defaults_outputs():
    req = EncodeRequest(input=["hello"])
    assert req.outputs == ["sparse", "colbert"]


def test_encode_rejects_empty_input():
    with pytest.raises(ValidationError):
        EncodeRequest(input=[])


def test_rerank_requires_query_and_documents():
    req = RerankRequest(query="q", documents=["a", "b"], top_n=1)
    assert req.query == "q"
    assert req.top_n == 1
    with pytest.raises(ValidationError):
        RerankRequest(query="q", documents=[])
