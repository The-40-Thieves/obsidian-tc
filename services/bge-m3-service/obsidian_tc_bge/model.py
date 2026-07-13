"""BGE-M3 encoder wrapper - one encode() produces aligned dense/sparse/ColBERT."""

from __future__ import annotations

from .contracts import ColbertVec, EncodeItem, Output, SparseVec


class BgeM3Encoder:
    def __init__(
        self,
        model_id: str,
        revision: str,
        device: str,
        use_fp16: bool,
        max_length: int,
    ) -> None:
        import torch
        from FlagEmbedding import BGEM3FlagModel

        resolved = device
        if device == "auto":
            resolved = "cuda" if torch.cuda.is_available() else "cpu"
        # BGE-M3 ships no custom modeling code - trust_remote_code is neither needed nor set.
        self._model = BGEM3FlagModel(
            model_id,
            use_fp16=(use_fp16 and resolved == "cuda"),
            devices=resolved,
        )
        self.model_id = model_id
        self.device = resolved
        self.max_length = max_length
        self.revision = self._resolve_revision(model_id, revision)

    @staticmethod
    def _resolve_revision(model_id: str, requested: str) -> str:
        try:
            from huggingface_hub import model_info

            return model_info(model_id, revision=requested).sha or requested
        except Exception:
            return requested

    def encode(self, texts: list[str], outputs: list[Output]) -> list[EncodeItem]:
        want_dense = "dense" in outputs
        want_sparse = "sparse" in outputs
        want_colbert = "colbert" in outputs
        out = self._model.encode(
            texts,
            return_dense=want_dense,
            return_sparse=want_sparse,
            return_colbert_vecs=want_colbert,
            max_length=self.max_length,
        )
        items: list[EncodeItem] = []
        for i in range(len(texts)):
            item = EncodeItem()
            if want_dense:
                item.dense = [float(x) for x in out["dense_vecs"][i]]
            if want_sparse:
                weights = out["lexical_weights"][i]
                item.sparse = SparseVec(
                    token_ids=[int(k) for k in weights],
                    weights=[float(v) for v in weights.values()],
                )
            if want_colbert:
                item.colbert = ColbertVec(
                    vectors=[[float(x) for x in v] for v in out["colbert_vecs"][i]]
                )
            items.append(item)
        return items
