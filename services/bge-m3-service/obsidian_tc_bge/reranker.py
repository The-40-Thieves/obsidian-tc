"""BGE cross-encoder reranker - a SEPARATE model from the bge-m3 encoder, loaded lazily so a
deployment that only encodes never pays its VRAM. bge-reranker-v2-m3 is stock XLM-RoBERTa (no custom
modeling code), so trust_remote_code stays OFF - the same safety property as the encoder."""

from __future__ import annotations


class BgeReranker:
    def __init__(self, model_id: str, revision: str, device: str, max_length: int) -> None:
        # CrossEncoder (sentence-transformers), not FlagReranker: the latter trips a slow-tokenizer
        # bug ("XLMRobertaTokenizer has no attribute prepare_for_model") on this model.
        from sentence_transformers import CrossEncoder

        self._model = CrossEncoder(
            model_id, device=device, max_length=max_length, trust_remote_code=False
        )
        self.model_id = model_id
        self.revision = self._resolve_revision(model_id, revision)

    @staticmethod
    def _resolve_revision(model_id: str, requested: str) -> str:
        try:
            from huggingface_hub import model_info

            return model_info(model_id, revision=requested).sha or requested
        except Exception:
            return requested

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
