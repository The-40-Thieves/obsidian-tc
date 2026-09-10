"""BgeM3Encoder loader (THE-1035): the model that gets loaded must actually be pinned to
`revision`, not just report it afterwards. torch / FlagEmbedding / huggingface_hub are lazy-imported
inside __init__ (the last one via the shared obsidian_tc_bge.hub helper), so fakes are injected
into sys.modules before construction and never touch real weights or the network."""

from __future__ import annotations

import sys
import types

import pytest


class _FakeTorch(types.ModuleType):
    class cuda:  # noqa: N801 - mirrors torch.cuda's attribute shape
        @staticmethod
        def is_available() -> bool:
            return False


class _FakeBGEM3FlagModel:
    """Records EVERY construction, not just the last - a mutant that constructs one instance and
    discards it in favour of a second (e.g. `Loader(model_id); Loader(snapshot_path, ...)`) is
    caught by asserting both the call count and that `encoder._model` IS the recorded instance,
    which a `last_call`-only fake cannot distinguish from the correct single-construction case."""

    instances: list["_FakeBGEM3FlagModel"] = []

    def __init__(self, model_name_or_path, **kwargs):
        self.call = {"model_name_or_path": model_name_or_path, **kwargs}
        type(self).instances.append(self)


def _install_fakes(monkeypatch, *, snapshot_download):
    _FakeBGEM3FlagModel.instances = []
    fake_flagembedding = types.ModuleType("FlagEmbedding")
    fake_flagembedding.BGEM3FlagModel = _FakeBGEM3FlagModel
    fake_hub = types.ModuleType("huggingface_hub")
    fake_hub.snapshot_download = snapshot_download

    monkeypatch.setitem(sys.modules, "torch", _FakeTorch("torch"))
    monkeypatch.setitem(sys.modules, "FlagEmbedding", fake_flagembedding)
    monkeypatch.setitem(sys.modules, "huggingface_hub", fake_hub)


def _model_module():
    # The heavy imports (torch, FlagEmbedding, huggingface_hub) live INSIDE BgeM3Encoder.__init__,
    # so importing this module never touches them - the fakes in sys.modules only need to be in
    # place by construction time, not by import time.
    import obsidian_tc_bge.model as model

    return model


def _snapshot_with_heads(tmp_path):
    """A fake hub-cache-shaped snapshot dir with both multi-vector head files present."""
    snap = tmp_path / "models--BAAI--bge-m3" / "snapshots" / "deadbeef0000"
    snap.mkdir(parents=True)
    (snap / "colbert_linear.pt").write_bytes(b"")
    (snap / "sparse_linear.pt").write_bytes(b"")
    return snap


def test_encoder_pins_the_snapshot_before_loading(monkeypatch, tmp_path):
    calls: list[dict[str, object]] = []
    snap = _snapshot_with_heads(tmp_path)

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
        # The hub cache lays a resolved revision out as `.../snapshots/<sha>` - deliberately a
        # DIFFERENT sha than the requested "abc123" so the test cannot pass by trivially echoing
        # the requested value back as `.revision`.
        return str(snap)

    _install_fakes(monkeypatch, snapshot_download=snapshot_download)
    model = _model_module()

    encoder = model.BgeM3Encoder("BAAI/bge-m3", "abc123", "cpu", False, 512)

    # SIZE + OFFLINE-COMPLETENESS REGRESSION GUARD: an ALLOW list (only what the loaders read) plus
    # the onnx exclude must reach the real call - a blanket ignore_patterns alone (the first cut of
    # this fix) either doubles first-start download/disk (BAAI/bge-m3's onnx/model.onnx_data alone
    # is ~2267 MB) or, worse, breaks an offline start against a cache the OLD code populated. See
    # obsidian_tc_bge/hub.py's module comment.
    assert calls == [
        {
            "repo_id": "BAAI/bge-m3",
            "revision": "abc123",
            "allow_patterns": ["*.json", "*.txt", "*.model", "*.bin", "*.safetensors", "*.pt"],
            "ignore_patterns": ["onnx/*"],
            "cache_dir": None,
        }
    ]
    assert encoder.model_id == "BAAI/bge-m3"
    assert encoder.revision == "deadbeef0000"


def test_encoder_ignores_sentence_transformers_home(monkeypatch, tmp_path):
    # SENTENCE_TRANSFORMERS_HOME is a sentence-transformers / reranker concept (THE-1035 item 3);
    # the encoder must not read it into cache_dir just because it happens to be set in the
    # process environment.
    calls: list[dict[str, object]] = []
    snap = _snapshot_with_heads(tmp_path)

    def snapshot_download(**kwargs):
        calls.append(kwargs)
        return str(snap)

    _install_fakes(monkeypatch, snapshot_download=snapshot_download)
    monkeypatch.setenv("SENTENCE_TRANSFORMERS_HOME", "/custom/st/home")
    model = _model_module()

    model.BgeM3Encoder("BAAI/bge-m3", "abc123", "cpu", False, 512)

    assert calls[0].get("cache_dir") is None


def test_encoder_constructs_flagmodel_with_the_snapshot_path_not_the_hub_id(monkeypatch, tmp_path):
    snap = _snapshot_with_heads(tmp_path)

    def snapshot_download(**_kwargs):
        return str(snap)

    _install_fakes(monkeypatch, snapshot_download=snapshot_download)
    model = _model_module()

    encoder = model.BgeM3Encoder("BAAI/bge-m3", "abc123", "cpu", False, 512)

    # THE REGRESSION GUARD: before THE-1035, BGEM3FlagModel(model_id, ...) was constructed with the
    # bare hub id and no revision at all, so a silent upstream update to "BAAI/bge-m3" changed what
    # loaded even with BGE_MODEL_REVISION pinned. Against that code this assertion fails because the
    # fake FlagEmbedding module records `model_name_or_path` as whatever BGEM3FlagModel's first
    # argument was, and the old code passed the bare model_id, not the snapshot path.
    #
    # Exactly one construction, and `encoder._model` IS that instance - catches a mutant that
    # constructs a throwaway instance from the hub id and then a second, real one from the
    # snapshot path (a `last_call`-only fake would pass that mutant; this cannot).
    assert len(_FakeBGEM3FlagModel.instances) == 1
    instance = _FakeBGEM3FlagModel.instances[0]
    assert instance.call["model_name_or_path"] == str(snap)
    assert encoder._model is instance


def test_encoder_falls_back_to_the_requested_revision_when_the_path_is_not_hub_shaped(
    monkeypatch, tmp_path
):
    snap = tmp_path / "not-hub-shaped"
    snap.mkdir()
    (snap / "colbert_linear.pt").write_bytes(b"")
    (snap / "sparse_linear.pt").write_bytes(b"")

    def snapshot_download(**_kwargs):
        return str(snap)

    _install_fakes(monkeypatch, snapshot_download=snapshot_download)
    model = _model_module()

    encoder = model.BgeM3Encoder("BAAI/bge-m3", "main", "cpu", False, 512)

    assert encoder.revision == "main"


def test_encoder_requires_both_multi_vector_heads(monkeypatch, tmp_path):
    snap = tmp_path / "missing-a-head"
    snap.mkdir()
    (snap / "colbert_linear.pt").write_bytes(b"")
    # sparse_linear.pt deliberately absent.

    def snapshot_download(**_kwargs):
        return str(snap)

    _install_fakes(monkeypatch, snapshot_download=snapshot_download)
    model = _model_module()

    # THE REGRESSION GUARD (pre-existing FlagEmbedding behaviour that THE-1035 now holds the load
    # path close enough to check): FlagEmbedding 1.4.0 initialises the sparse/ColBERT heads
    # RANDOMLY and only loads their trained state if BOTH colbert_linear.pt and sparse_linear.pt
    # are present - otherwise it silently logs and serves random vectors, now under a pinned,
    # correctly-reported sha. A snapshot missing either file must fail loudly, and the loader must
    # never be constructed at all.
    with pytest.raises(RuntimeError, match="sparse_linear.pt"):
        model.BgeM3Encoder("BAAI/bge-m3", "abc123", "cpu", False, 512)

    assert _FakeBGEM3FlagModel.instances == []


def test_encoder_loads_when_both_multi_vector_heads_are_present(monkeypatch, tmp_path):
    snap = _snapshot_with_heads(tmp_path)

    def snapshot_download(**_kwargs):
        return str(snap)

    _install_fakes(monkeypatch, snapshot_download=snapshot_download)
    model = _model_module()

    model.BgeM3Encoder("BAAI/bge-m3", "abc123", "cpu", False, 512)

    assert len(_FakeBGEM3FlagModel.instances) == 1


def test_encoder_constructs_no_loader_when_pinned_snapshot_raises(monkeypatch):
    def snapshot_download(**_kwargs):
        raise RuntimeError("network unavailable")

    _install_fakes(monkeypatch, snapshot_download=snapshot_download)
    model = _model_module()

    with pytest.raises(RuntimeError, match="network unavailable"):
        model.BgeM3Encoder("BAAI/bge-m3", "abc123", "cpu", False, 512)

    assert _FakeBGEM3FlagModel.instances == []
