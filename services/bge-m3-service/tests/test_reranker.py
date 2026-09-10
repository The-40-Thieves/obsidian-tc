"""BgeReranker loader (THE-1035): CrossEncoder must actually load the pinned snapshot, not just
report a revision afterwards. torch / sentence_transformers / huggingface_hub are lazy-imported
(the last one via the shared obsidian_tc_bge.hub helper), so fakes are injected into sys.modules
before construction and never touch real weights or the network. The reranker has no
sparse/ColBERT heads (THE-1035 item 4 is BGE-M3-specific), so no missing-file check applies here."""

from __future__ import annotations

import sys
import types

import pytest


class _FakeTorch(types.ModuleType):
    class cuda:  # noqa: N801 - mirrors torch.cuda's attribute shape
        @staticmethod
        def is_available() -> bool:
            return False


class _FakeCrossEncoder:
    """Records EVERY construction, not just the last - see _FakeBGEM3FlagModel in test_model.py
    for why that matters."""

    instances: list["_FakeCrossEncoder"] = []

    def __init__(self, model_name_or_path, **kwargs):
        self.call = {"model_name_or_path": model_name_or_path, **kwargs}
        type(self).instances.append(self)


def _install_fakes(monkeypatch, *, snapshot_download):
    _FakeCrossEncoder.instances = []
    fake_st = types.ModuleType("sentence_transformers")
    fake_st.CrossEncoder = _FakeCrossEncoder
    fake_hub = types.ModuleType("huggingface_hub")
    fake_hub.snapshot_download = snapshot_download

    monkeypatch.setitem(sys.modules, "torch", _FakeTorch("torch"))
    monkeypatch.setitem(sys.modules, "sentence_transformers", fake_st)
    monkeypatch.setitem(sys.modules, "huggingface_hub", fake_hub)


def _reranker_module():
    import obsidian_tc_bge.reranker as reranker

    return reranker


def test_reranker_pins_the_snapshot_before_loading(monkeypatch):
    calls: list[dict[str, object]] = []

    def snapshot_download(
        *, repo_id, revision, allow_patterns=None, ignore_patterns=None, cache_dir=None
    ):
        calls.append(
            {
                "repo_id": repo_id,
                "revision": revision,
                "allow_patterns": allow_patterns,
                "ignore_patterns": ignore_patterns,
                "cache_dir": cache_dir,
            }
        )
        # Deliberately a DIFFERENT sha than the requested "main" so the test cannot pass by
        # trivially echoing the requested value back as `.revision`.
        return "/fake/hub/models--BAAI--bge-reranker-v2-m3/snapshots/cafef00d0000"

    _install_fakes(monkeypatch, snapshot_download=snapshot_download)
    reranker = _reranker_module()

    instance = reranker.BgeReranker("BAAI/bge-reranker-v2-m3", "main", "cpu", 512)

    assert calls == [
        {
            "repo_id": "BAAI/bge-reranker-v2-m3",
            "revision": "main",
            "allow_patterns": ["*.json", "*.txt", "*.model", "*.bin", "*.safetensors", "*.pt"],
            "ignore_patterns": ["onnx/*"],
            "cache_dir": None,  # SENTENCE_TRANSFORMERS_HOME unset in this test
        }
    ]
    assert instance.model_id == "BAAI/bge-reranker-v2-m3"
    assert instance.revision == "cafef00d0000"


def test_reranker_forwards_sentence_transformers_home_as_cache_dir(monkeypatch):
    # THE REGRESSION GUARD (THE-1035 item 3): sentence-transformers forwards
    # SENTENCE_TRANSFORMERS_HOME to the hub client as `cache_dir` - same `models--*/snapshots/<sha>`
    # layout, different root. Before this, `pinned_snapshot` ignored it, so a reranker whose weights
    # live only there would re-download online and fail outright offline.
    calls: list[dict[str, object]] = []

    def snapshot_download(**kwargs):
        calls.append(kwargs)
        return "/fake/hub/models--BAAI--bge-reranker-v2-m3/snapshots/cafef00d0000"

    _install_fakes(monkeypatch, snapshot_download=snapshot_download)
    monkeypatch.setenv("SENTENCE_TRANSFORMERS_HOME", "/custom/st/home")
    reranker = _reranker_module()

    reranker.BgeReranker("BAAI/bge-reranker-v2-m3", "main", "cpu", 512)

    assert calls[0]["cache_dir"] == "/custom/st/home"


def test_reranker_constructs_crossencoder_with_the_snapshot_path_not_the_hub_id(monkeypatch):
    def snapshot_download(**_kwargs):
        return "/fake/hub/models--BAAI--bge-reranker-v2-m3/snapshots/cafef00d0000"

    _install_fakes(monkeypatch, snapshot_download=snapshot_download)
    reranker = _reranker_module()

    instance = reranker.BgeReranker("BAAI/bge-reranker-v2-m3", "main", "cpu", 512)

    # THE REGRESSION GUARD: before THE-1035, CrossEncoder(model_id, ...) was constructed with the
    # bare hub id and no revision at all (a resolved sha was only reported afterwards, via a
    # cosmetic huggingface_hub.model_info round-trip, never fed back into the load) - so a silent
    # upstream update to "BAAI/bge-reranker-v2-m3" changed what loaded even with
    # BGE_RERANKER_REVISION pinned.
    #
    # Exactly one construction, and `instance._model` IS that recorded instance - catches a mutant
    # that constructs a throwaway instance from the hub id and then a second, real one from the
    # snapshot path (a `last_call`-only fake would pass that mutant; this cannot).
    assert len(_FakeCrossEncoder.instances) == 1
    call = _FakeCrossEncoder.instances[0]
    assert call.call["model_name_or_path"] == (
        "/fake/hub/models--BAAI--bge-reranker-v2-m3/snapshots/cafef00d0000"
    )
    assert instance._model is call


def test_reranker_falls_back_to_the_requested_revision_when_the_path_is_not_hub_shaped(
    monkeypatch,
):
    def snapshot_download(**_kwargs):
        return "/some/local/dir/not/hub/cache/shaped"

    _install_fakes(monkeypatch, snapshot_download=snapshot_download)
    reranker = _reranker_module()

    instance = reranker.BgeReranker("BAAI/bge-reranker-v2-m3", "main", "cpu", 512)

    assert instance.revision == "main"


def test_reranker_constructs_no_loader_when_pinned_snapshot_raises(monkeypatch):
    def snapshot_download(**_kwargs):
        raise RuntimeError("network unavailable")

    _install_fakes(monkeypatch, snapshot_download=snapshot_download)
    reranker = _reranker_module()

    with pytest.raises(RuntimeError, match="network unavailable"):
        reranker.BgeReranker("BAAI/bge-reranker-v2-m3", "main", "cpu", 512)

    assert _FakeCrossEncoder.instances == []
