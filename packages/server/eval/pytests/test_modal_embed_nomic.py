"""Unit tests for eval/modal_embed_nomic.py -- batching, budget, order, OOM splitting, pooling, CUDA
preload and the pin contract. Everything is mocked; nothing here needs a GPU."""

import json
import os
import random
import re
import struct
from pathlib import Path

import numpy as np
import pytest

import modal_embed_nomic as m

SCRIPT = Path(m.__file__)


# --- pins -------------------------------------------------------------------------------------


def _pins_file(tmp_path: Path, mutate=None) -> Path:
    data = json.loads(m.PINS_PATH.read_text(encoding="utf-8"))
    if mutate:
        mutate(data["models"][m.MODEL_NAME])
    p = tmp_path / "pins.json"
    p.write_text(json.dumps(data), encoding="utf-8")
    return p


def test_pins_are_read_from_the_generated_json_not_restated():
    data = json.loads(m.PINS_PATH.read_text(encoding="utf-8"))["models"][m.MODEL_NAME]
    assert m.PINS.model_id == data["modelId"]
    assert m.PINS.revision == data["revision"]
    assert m.PINS.dim == m.DIM == data["dimensions"] == 768
    assert set(m.PINS.files) >= set(m.REQUIRED_FILES)
    assert all(re.fullmatch(r"[0-9a-f]{64}", h) for h in m.PINS.files.values())


def test_the_script_restates_no_pinned_literal():
    source = SCRIPT.read_text(encoding="utf-8")
    assert not re.search(r"\b[0-9a-f]{40}\b|\b[0-9a-f]{64}\b", source)
    assert m.PINS.model_id not in source


def test_load_pins_refuses_a_pooling_it_does_not_implement(tmp_path):
    p = _pins_file(tmp_path, lambda model: model.update(pooling="cls"))
    with pytest.raises(SystemExit, match="mean' only"):
        m.load_pins(p)


def test_load_pins_refuses_an_unknown_model_and_a_missing_file(tmp_path):
    with pytest.raises(SystemExit, match="no model 'nope'"):
        m.load_pins(m.PINS_PATH, name="nope")
    p = _pins_file(
        tmp_path,
        lambda model: model["variants"]["fp32"].update(
            files=[f for f in model["variants"]["fp32"]["files"] if f["path"] != "tokenizer.json"]
        ),
    )
    with pytest.raises(SystemExit, match="does not pin"):
        m.load_pins(p)


def test_verify_pins_accepts_matching_bytes_and_rejects_a_drifted_file(tmp_path):
    blob = tmp_path / "f.bin"
    blob.write_bytes(b"pinned bytes")
    good = m.Pins("org/model", "rev", 4, {"f.bin": m.hashlib.sha256(b"pinned bytes").hexdigest()})
    assert m.verify_pins(lambda rel: str(blob), good) == {"f.bin": str(blob)}
    drifted = m.Pins("org/model", "rev", 4, {"f.bin": "0" * 64})
    with pytest.raises(SystemExit, match="checksum mismatch for f.bin"):
        m.verify_pins(lambda rel: str(blob), drifted)


# --- batching, budget, order ------------------------------------------------------------------


def test_plan_batches_is_a_partition_within_both_bounds():
    rng = random.Random(7)
    lengths = [rng.randint(1, 600) for _ in range(500)]
    batches = m.plan_batches(lengths)
    assert sorted(i for b in batches for i in b) == list(range(len(lengths)))
    for b in batches:
        assert len(b) <= m.MAX_BATCH
        widest = max(lengths[i] for i in b)
        if len(b) > 1:
            assert len(b) * widest * widest <= m.ATTN_BUDGET
        # length-sorted: padding width is set by a near neighbour
        assert [lengths[i] for i in b] == sorted(lengths[i] for i in b)


def test_plan_batches_buckets_short_texts_wide_and_long_texts_narrow():
    assert max(len(b) for b in m.plan_batches([10] * 100)) == m.MAX_BATCH
    # 8 rows * 1000^2 is exactly the 8e6 budget; a ninth would exceed it
    assert [len(b) for b in m.plan_batches([1000] * 20)] == [8, 8, 4]
    # one 3000-token row alone is already over budget (9e6) and still gets its own batch
    assert [len(b) for b in m.plan_batches([3000] * 3)] == [1, 1, 1]


def test_plan_batches_gives_an_over_budget_row_its_own_batch_and_handles_empty():
    assert m.plan_batches([5000, 5, 5]) == [[1, 2], [0]]
    assert m.plan_batches([]) == []


def test_embed_sequences_returns_input_order_whatever_the_batching():
    rng = random.Random(3)
    seqs = [[rng.randint(1, 99)] * rng.randint(1, 80) for _ in range(200)]
    calls: list[list[int]] = []

    def forward(idx):
        calls.append(list(idx))
        return [[float(len(seqs[i])), float(seqs[i][0])] for i in idx]

    out = m.embed_sequences(seqs, forward)
    assert out == [[float(len(s)), float(s[0])] for s in seqs]
    assert any(c != sorted(c) for c in calls)  # batches really were formed out of input order


def test_embed_sequences_fails_if_a_text_produced_no_vector():
    with pytest.raises(SystemExit, match="produced no vector"):
        m.embed_sequences([[1], [2]], lambda idx: [None] * len(idx))


# --- OOM splitting ----------------------------------------------------------------------------


def test_forward_split_halves_on_allocation_failure_and_keeps_every_row():
    seen: list[int] = []

    def forward(idx):
        if len(idx) > 3:
            raise RuntimeError("CUDA failure: Failed to allocate memory for requested buffer")
        seen.append(len(idx))
        return [[float(i)] for i in idx]

    out: list = [None] * 10
    m.forward_split(forward, list(range(10)), out)
    assert out == [[float(i)] for i in range(10)]
    assert max(seen) <= 3


def test_forward_split_does_not_swallow_a_non_allocation_error():
    calls = []

    def forward(idx):
        calls.append(len(idx))
        raise ValueError("shape mismatch")

    with pytest.raises(ValueError, match="shape mismatch"):
        m.forward_split(forward, [0, 1, 2, 3], [None] * 4)
    assert calls == [4]  # no retry one row at a time behind a misleading OOM story


def test_forward_split_gives_up_when_a_single_row_cannot_be_allocated():
    def forward(idx):
        raise RuntimeError("cudaErrorMemoryAllocation")

    with pytest.raises(RuntimeError, match="cudaErrorMemoryAllocation"):
        m.forward_split(forward, [0, 1], [None] * 2)


# --- padding / pooling against a mock session -------------------------------------------------


class FakeSession:
    """ORT-shaped: hidden state = a fixed embedding table looked up by input_ids (+ position
    noise that padding must not leak into the pooled vector)."""

    def __init__(self, vocab=64, dim=m.DIM, input_names=("input_ids", "attention_mask")):
        self.table = np.random.default_rng(0).standard_normal((vocab, dim)).astype(np.float32)
        self.names = list(input_names)
        self.feeds: list[dict] = []

    def get_providers(self):
        return ["CUDAExecutionProvider", "CPUExecutionProvider"]

    def get_inputs(self):
        return [type("I", (), {"name": n}) for n in self.names]

    def run(self, _outputs, feed):
        self.feeds.append(feed)
        return [self.table[feed["input_ids"]]]


def test_pad_batch_pads_right_and_masks():
    ids, mask = m.pad_batch([[5, 6], [7, 8, 9], [4]], [0, 1, 2], pad_id=3)
    assert ids.tolist() == [[5, 6, 3], [7, 8, 9], [4, 3, 3]]
    assert mask.tolist() == [[1, 1, 0], [1, 1, 1], [1, 0, 0]]


def test_pooling_is_padding_invariant_and_unit_norm():
    sess = FakeSession()
    seqs = [[1, 2, 3], [4, 5, 6, 7, 8, 9, 10, 11]]
    fwd = m.make_forward(sess, {"input_ids", "attention_mask"}, seqs, pad_id=0, dim=m.DIM)
    alone = fwd([0])[0]
    batched = fwd([0, 1])[0]  # the same text, padded out to 8 tokens beside a longer one
    assert np.allclose(alone, batched, atol=1e-6)
    expected = sess.table[[1, 2, 3]].mean(axis=0)
    expected /= np.linalg.norm(expected)
    assert np.allclose(alone, expected, atol=1e-6)
    assert np.isclose(np.linalg.norm(alone), 1.0)


def test_token_type_ids_are_fed_only_when_the_graph_declares_them():
    seqs = [[1, 2]]
    plain = FakeSession()
    m.make_forward(plain, {"input_ids", "attention_mask"}, seqs, 0, m.DIM)([0])
    assert set(plain.feeds[0]) == {"input_ids", "attention_mask"}
    typed = FakeSession()
    names = {"input_ids", "attention_mask", "token_type_ids"}
    m.make_forward(typed, names, seqs, 0, m.DIM)([0])
    assert set(typed.feeds[0]) == names


def test_make_forward_rejects_a_wrong_width():
    sess = FakeSession(dim=8)
    with pytest.raises(SystemExit, match="width 8 != expected 768"):
        m.make_forward(sess, {"input_ids", "attention_mask"}, [[1]], 0, m.DIM)([0])


class FakeTokenizer:
    def encode_batch(self, texts):
        return [type("E", (), {"ids": [1 + (ord(c) % 60) for c in t] or [1]}) for t in texts]


def test_embedder_embed_returns_packed_float32_in_input_order():
    e = m.Embedder()
    e.tok = FakeTokenizer()
    e.sess = FakeSession()
    e.input_names = {"input_ids", "attention_mask"}
    e.pad_id = 0
    texts = ["a", "bbbbbbbbbbbbbbbbbbbb", "cc", "ddddd", "e" * 40]
    blob = e.embed(texts)
    assert len(blob) == len(texts) * m.DIM * 4
    got = np.frombuffer(blob, dtype="<f4").reshape(len(texts), m.DIM)
    for i, t in enumerate(texts):
        ids = [1 + (ord(c) % 60) for c in t]
        want = e.sess.table[ids].mean(axis=0)
        want /= np.linalg.norm(want)
        assert np.allclose(got[i], want, atol=1e-6), f"row {i} is not text {i}'s vector"


# --- CUDA -------------------------------------------------------------------------------------


def _fake_nvidia(tmp_path: Path, names: list[str]) -> str:
    lib = tmp_path / "nvidia" / "cublas" / "lib"
    lib.mkdir(parents=True)
    for n in names:
        (lib / n).write_bytes(b"")
    return str(tmp_path / "nvidia")


def test_preload_retries_a_lib_that_needs_a_sibling_loaded_first(tmp_path):
    root = _fake_nvidia(tmp_path, ["liba.so.12", "libb.so.12"])
    loaded: list[str] = []

    def loader(path, mode):
        if path.endswith("liba.so.12") and not any(p.endswith("libb.so.12") for p in loaded):
            raise OSError("needs libb")
        loaded.append(path)

    assert m.preload_cuda_libs([root], loader=loader) == 2
    assert [Path(p).name for p in loaded] == ["libb.so.12", "liba.so.12"]


def test_preload_is_fatal_when_nothing_loads(tmp_path):
    root = _fake_nvidia(tmp_path, ["liba.so.12"])

    def loader(path, mode):
        raise OSError("nope")

    with pytest.raises(SystemExit, match="preloaded no CUDA libraries"):
        m.preload_cuda_libs([root], loader=loader)
    with pytest.raises(SystemExit, match="preloaded no CUDA libraries"):
        m.preload_cuda_libs([str(tmp_path / "empty")], loader=loader)


def test_require_cuda_refuses_a_cpu_fallback():
    cpu = type("S", (), {"get_providers": lambda self: ["CPUExecutionProvider"]})()
    with pytest.raises(SystemExit, match="refusing to embed on CPU"):
        m.require_cuda(cpu)
    m.require_cuda(FakeSession())


# --- output file contract ---------------------------------------------------------------------


def _blob(n: int, fill: float = 1.0) -> bytes:
    return struct.pack(f"<{n * m.DIM}f", *([fill] * (n * m.DIM)))


def test_write_vectors_writes_the_complete_file_and_leaves_no_partial(tmp_path):
    out = tmp_path / "vecs.f32"
    n = m.write_vectors(str(out), [_blob(2), _blob(1)], [2, 1])
    assert n == 3
    assert out.stat().st_size == 3 * m.DIM * 4
    assert not Path(f"{out}.partial").exists()


@pytest.mark.parametrize(
    ("blobs", "sizes", "msg"),
    [
        ([_blob(1)], [2], "expected"),  # a short shard
        ([_blob(2)], [2, 1], "partial file"),  # a shard never returned
        ([_blob(1), _blob(1)], [1], "more shards returned"),
    ],
)
def test_write_vectors_refuses_a_partial_result_and_keeps_an_earlier_good_file(
    tmp_path, blobs, sizes, msg
):
    out = tmp_path / "vecs.f32"
    out.write_bytes(b"previous complete run")
    with pytest.raises(SystemExit, match=msg):
        m.write_vectors(str(out), blobs, sizes)
    assert out.read_bytes() == b"previous complete run"
    assert not Path(f"{out}.partial").exists()


def test_write_vectors_cleans_up_when_the_remote_call_dies_midway(tmp_path):
    out = tmp_path / "vecs.f32"

    def shards():
        yield _blob(1)
        raise ConnectionError("worker lost")

    with pytest.raises(ConnectionError):
        m.write_vectors(str(out), shards(), [1, 1])
    assert not out.exists()
    assert not Path(f"{out}.partial").exists()
    assert os.listdir(tmp_path) == []
