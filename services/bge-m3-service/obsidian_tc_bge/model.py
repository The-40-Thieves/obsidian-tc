"""BGE-M3 encoder wrapper - one encode() produces aligned dense/sparse/ColBERT."""

from __future__ import annotations

from pathlib import Path

from .contracts import ColbertVec, EncodeItem, Output, SparseVec
from .hub import pinned_snapshot

# FlagEmbedding 1.4.0 initialises the sparse and ColBERT heads RANDOMLY and only loads their
# trained state if BOTH files are present in the model directory - otherwise it just logs and
# silently serves random sparse/ColBERT vectors. A snapshot missing either would do that under a
# pinned, correctly-reported sha - worse than the bug THE-1035 fixed, since the revision would now
# look verified while the vectors are garbage. Required regardless of whether the directory came
# from `snapshot_download` or an operator-provided local path.
_REQUIRED_MULTI_VECTOR_HEADS = ("colbert_linear.pt", "sparse_linear.pt")


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

        # Resolve the pin to a concrete local snapshot BEFORE loading (THE-1035). FlagEmbedding's
        # BGEM3FlagModel takes no revision parameter at all, so the only way to actually pin what
        # loads - rather than merely report a sha afterwards - is to hand it a path that is already
        # pinned. "main" (the dev default) still resolves through here, honestly reporting whatever
        # sha it currently points at instead of the literal string "main".
        snapshot_path, loaded_revision = pinned_snapshot(model_id, revision)
        self._require_multi_vector_heads(snapshot_path)
        # BGE-M3 ships no custom modeling code - trust_remote_code is neither needed nor set.
        self._model = BGEM3FlagModel(
            snapshot_path,
            use_fp16=(use_fp16 and resolved == "cuda"),
            devices=resolved,
        )
        self.model_id = model_id
        self.device = resolved
        self.max_length = max_length
        self.revision = loaded_revision

    @staticmethod
    def _require_multi_vector_heads(snapshot_path: str) -> None:
        missing = [
            name for name in _REQUIRED_MULTI_VECTOR_HEADS if not (Path(snapshot_path) / name).exists()
        ]
        if missing:
            raise RuntimeError(
                f"snapshot at {snapshot_path!r} is missing required file(s) {missing} - "
                "BGE-M3's sparse/ColBERT heads would load with random, untrained weights"
            )

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
