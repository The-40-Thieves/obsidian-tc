"""pinned_snapshot (THE-1035): the shared pin-resolution helper both loaders call.
huggingface_hub is lazy-imported inside the function, so a fake is injected into sys.modules
before calling it - no network, no real weights."""

from __future__ import annotations

import sys
import types


def _install_fake_hub(monkeypatch, *, snapshot_download):
    fake_hub = types.ModuleType("huggingface_hub")
    fake_hub.snapshot_download = snapshot_download
    monkeypatch.setitem(sys.modules, "huggingface_hub", fake_hub)


def _hub_module():
    import obsidian_tc_bge.hub as hub

    return hub


def test_pinned_snapshot_derives_the_sha_from_a_hub_cache_shaped_path(monkeypatch):
    def snapshot_download(**_kwargs):
        return "/fake/hub/models--BAAI--bge-m3/snapshots/deadbeef0000"

    _install_fake_hub(monkeypatch, snapshot_download=snapshot_download)
    hub = _hub_module()

    path, revision = hub.pinned_snapshot("BAAI/bge-m3", "abc123")

    assert path == "/fake/hub/models--BAAI--bge-m3/snapshots/deadbeef0000"
    # Deliberately a DIFFERENT sha than the requested "abc123" - proves the value comes from the
    # returned path, not an echo of the request.
    assert revision == "deadbeef0000"


def test_pinned_snapshot_falls_back_to_the_requested_revision_for_a_non_cache_path(monkeypatch):
    def snapshot_download(**_kwargs):
        return "/some/local/dir/not/hub/cache/shaped"

    _install_fake_hub(monkeypatch, snapshot_download=snapshot_download)
    hub = _hub_module()

    _, revision = hub.pinned_snapshot("BAAI/bge-m3", "main")

    assert revision == "main"


def test_pinned_snapshot_passes_repo_id_and_revision_through(monkeypatch):
    calls: list[dict[str, object]] = []

    def snapshot_download(**kwargs):
        calls.append(kwargs)
        return "/fake/hub/models--BAAI--bge-m3/snapshots/deadbeef0000"

    _install_fake_hub(monkeypatch, snapshot_download=snapshot_download)
    hub = _hub_module()

    hub.pinned_snapshot("BAAI/bge-m3", "abc123")

    assert calls[0]["repo_id"] == "BAAI/bge-m3"
    assert calls[0]["revision"] == "abc123"


def test_pinned_snapshot_uses_an_allow_list_plus_the_onnx_exclude(monkeypatch):
    calls: list[dict[str, object]] = []

    def snapshot_download(**kwargs):
        calls.append(kwargs)
        return "/fake/hub/models--BAAI--bge-m3/snapshots/deadbeef0000"

    _install_fake_hub(monkeypatch, snapshot_download=snapshot_download)
    hub = _hub_module()

    hub.pinned_snapshot("BAAI/bge-m3", "abc123")

    # SIZE + OFFLINE-COMPLETENESS REGRESSION GUARD: a blanket ignore_patterns=["onnx/*", "imgs/*"]
    # (the first cut of this fix) still let snapshot_download demand README.md and other assets
    # neither loader reads - with HF_HUB_OFFLINE=1 and a cache populated by the pre-THE-1035 code
    # (fetched only what it needed), that raised IncompleteSnapshotError on start, reproduced with
    # only README.md missing. An ALLOW list of only what the loaders actually read (plus excluding
    # onnx/*, which `*.json` would otherwise let through via onnx/tokenizer.json) avoids demanding
    # files nothing needs, while BAAI/bge-m3's ~2267 MB onnx export is still skipped.
    assert calls[0]["allow_patterns"] == [
        "*.json",
        "*.txt",
        "*.model",
        "*.bin",
        "*.safetensors",
        "*.pt",
    ]
    assert calls[0]["ignore_patterns"] == ["onnx/*"]


def test_pinned_snapshot_forwards_cache_dir(monkeypatch):
    calls: list[dict[str, object]] = []

    def snapshot_download(**kwargs):
        calls.append(kwargs)
        return "/fake/hub/models--BAAI--bge-reranker-v2-m3/snapshots/cafef00d0000"

    _install_fake_hub(monkeypatch, snapshot_download=snapshot_download)
    hub = _hub_module()

    hub.pinned_snapshot("BAAI/bge-reranker-v2-m3", "main", cache_dir="/custom/st/home")

    assert calls[0]["cache_dir"] == "/custom/st/home"


def test_pinned_snapshot_passes_a_local_directory_straight_through(monkeypatch, tmp_path):
    # A local directory as model_id is operator-provenanced: there is no hub call to make, so the
    # pin cannot be verified - the "loaded" revision is simply whatever was configured, on trust.
    calls: list[dict[str, object]] = []

    def snapshot_download(**kwargs):
        calls.append(kwargs)
        raise AssertionError("snapshot_download must not be called for a local directory")

    _install_fake_hub(monkeypatch, snapshot_download=snapshot_download)
    hub = _hub_module()

    local_dir = tmp_path / "my-local-bge-m3"
    local_dir.mkdir()

    # THE REGRESSION GUARD: before this fix, a local-directory model_id (which both
    # BGEM3FlagModel and CrossEncoder have always accepted directly) was handed to
    # snapshot_download, which raises HFValidationError given a path instead of a repo id.
    path, revision = hub.pinned_snapshot(str(local_dir), "unused")

    assert path == str(local_dir)
    assert revision == "unused"
    assert calls == []
