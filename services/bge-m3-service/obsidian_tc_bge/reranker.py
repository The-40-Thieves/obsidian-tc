"""BGE cross-encoder reranker - a SEPARATE model from the bge-m3 encoder, loaded lazily so a
deployment that only encodes never pays its VRAM. bge-reranker-v2-m3 is stock XLM-RoBERTa (no custom
modeling code), so trust_remote_code stays OFF - the same safety property as the encoder."""

from __future__ import annotations

import os

from .hub import pinned_snapshot


class BgeReranker:
    def __init__(self, model_id: str, revision: str, device: str, max_length: int) -> None:
        # CrossEncoder (sentence-transformers), not FlagReranker: the latter trips a slow-tokenizer
        # bug ("XLMRobertaTokenizer has no attribute prepare_for_model") on this model.
        import torch
        from sentence_transformers import CrossEncoder

        # sentence-transformers 5.x passes device straight to torch.to(), which rejects "auto"
        # (only concrete types like cuda/cpu). The encoder resolves it too; the reranker had relied
        # on ST to resolve it, which broke across the ST 3 -> 5 major.
        resolved = device
        if device == "auto":
            resolved = "cuda" if torch.cuda.is_available() else "cpu"

        # Resolve the pin to a concrete local snapshot BEFORE loading (THE-1035), same mechanism as
        # the encoder. CrossEncoder DOES accept a `revision=` kwarg, but resolving via a metadata-only
        # API call needs the network even when the pinned sha is already cached (breaking the pinned
        # sha + HF_HUB_OFFLINE=1 case this pin exists for), and passing the requested value straight
        # through would let a mutable ref like "main" load whatever upstream now points at.
        # `pinned_snapshot` gives back a local directory - CrossEncoder loads from a local path
        # without fetching anything - so this stays a single download either way.
        #
        # sentence-transformers itself passes SENTENCE_TRANSFORMERS_HOME to the hub client as
        # cache_dir (same models--*/snapshots/<sha> layout, different root); forward it so a
        # reranker cached only there resolves from that cache instead of re-downloading online
        # (and failing outright with HF_HUB_OFFLINE=1).
        snapshot_path, loaded_revision = pinned_snapshot(
            model_id, revision, cache_dir=os.environ.get("SENTENCE_TRANSFORMERS_HOME")
        )
        self._model = CrossEncoder(
            snapshot_path, device=resolved, max_length=max_length, trust_remote_code=False
        )
        self.model_id = model_id
        self.revision = loaded_revision

    def rerank(
        self, query: str, documents: list[str], top_n: int | None = None
    ) -> list[tuple[int, float]]:
        import numpy as np

        pairs = [[query, d] for d in documents]
        logits = np.asarray(self._model.predict(pairs), dtype=float).reshape(-1)
        scores = 1.0 / (1.0 + np.exp(-logits))  # sigmoid -> [0, 1] relevance
        order = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)
        if top_n:
            order = order[:top_n]
        return [(i, float(scores[i])) for i in order]
