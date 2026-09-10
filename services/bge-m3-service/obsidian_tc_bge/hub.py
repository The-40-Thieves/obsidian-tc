"""Shared model-pin resolution (THE-1035): both the encoder and the reranker need to turn a
configured revision into a concrete local snapshot BEFORE the model loads - not just report a sha
afterwards. Kept in one place so the two loaders share one mechanism and one regression surface."""

from __future__ import annotations

from pathlib import Path

# An ALLOW list, not a blanket exclude: FlagEmbedding reads config/tokenizer files,
# pytorch_model.bin / model.safetensors, colbert_linear.pt, sparse_linear.pt; CrossEncoder reads
# the standard transformers files. A blanket `ignore_patterns=["onnx/*", "imgs/*"]` (the first cut
# of this fix) still let snapshot_download demand README.md and other assets neither loader reads -
# with `HF_HUB_OFFLINE=1` and a cache populated by the pre-THE-1035 code (which fetched only what
# it needed), that raises `IncompleteSnapshotError` on start, reproduced with only README.md
# missing. Allowing only what a loader could plausibly read avoids that, while `ignore_patterns`
# still excludes the ONNX export `*.json` would otherwise let through via onnx/tokenizer.json -
# BAAI/bge-m3's onnx/model.onnx_data alone is ~2267 MB that neither loader ever touches.
_ALLOW_PATTERNS = ["*.json", "*.txt", "*.model", "*.bin", "*.safetensors", "*.pt"]
_IGNORE_PATTERNS = ["onnx/*"]


def pinned_snapshot(
    model_id: str, revision: str, cache_dir: str | None = None
) -> tuple[str, str]:
    """Resolve `revision` to a local snapshot directory before anything loads it.

    A local directory as `model_id` (an operator's own weights already on disk) is passed through
    unchanged, `(model_id, revision)`: `snapshot_download` raises `HFValidationError` given a path
    instead of a repo id, and "load exactly this directory" is the only meaning a local path can
    have. The pin can't be verified against a hub revision in that case - there is no hub call to
    make - so the reported revision is simply whatever was configured, on the operator's own
    provenance, not something this function has confirmed.

    Otherwise returns `(snapshot_path, loaded_revision)` from `huggingface_hub.snapshot_download`.
    `cache_dir` is forwarded when given - sentence-transformers' `SENTENCE_TRANSFORMERS_HOME` uses
    the same `models--*/snapshots/<sha>` cache layout under a different root, so a caller whose
    weights live only there must point at it explicitly or the resolve re-downloads online and
    fails outright offline. `loaded_revision` is derived from the snapshot path actually returned,
    not echoed from `revision`, so it reflects what was truly pinned even when `revision` is a
    mutable ref like "main". `snapshot_download` resolves against the local cache when offline
    (e.g. `HF_HUB_OFFLINE=1`) as long as the allowed files for that exact revision were cached
    before - which is why callers should resolve here rather than through a metadata-only API call
    that requires the network even when the pinned weights are already on disk.
    """
    # Assumes operators pass either a bare hub id or an ABSOLUTE local path: a relative hub id
    # like "BAAI/bge-m3" would take this branch if a directory of that exact relative path
    # happened to exist under the process cwd - the same ambiguity transformers' own
    # from_pretrained has always had for the old code path.
    if Path(model_id).is_dir():
        return model_id, revision

    from huggingface_hub import snapshot_download

    snapshot_path = snapshot_download(
        repo_id=model_id,
        revision=revision,
        cache_dir=cache_dir,
        allow_patterns=_ALLOW_PATTERNS,
        ignore_patterns=_IGNORE_PATTERNS,
    )
    return snapshot_path, _loaded_revision(snapshot_path, revision)


def _loaded_revision(snapshot_path: str, requested: str) -> str:
    # huggingface_hub's cache lays a resolved revision out as `.../snapshots/<sha>` - the
    # directory name IS the commit sha that was actually loaded. Report that when the shape
    # matches. Otherwise (an exotic HF_HOME layout, for instance) there is nothing better to go
    # on, so this returns the requested ref as-is - a statement of "we don't know", not a claim
    # that it was verified.
    path = Path(snapshot_path)
    if path.parent.name == "snapshots" and path.name:
        return path.name
    return requested
