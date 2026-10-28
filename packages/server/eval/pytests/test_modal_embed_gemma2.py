"""Unit tests for eval/modal_embed_gemma2.py: pins, MRL truncation, the float16 refusal,
the embed contract and the output file contract. Everything is mocked; no GPU, torch or modal."""

import json
import re
from pathlib import Path

import numpy as np
import pytest

import modal_embed_gemma2 as g

SCRIPT = Path(g.__file__)


# --- pins -------------------------------------------------------------------------------------


def _pins_file(tmp_path: Path, mutate=None) -> Path:
    data = json.loads(g.PINS_PATH.read_text(encoding="utf-8"))
    if mutate:
        mutate(data["evalOnly"][g.MODEL_NAME])
    p = tmp_path / "pins.json"
    p.write_text(json.dumps(data), encoding="utf-8")
    return p


def test_pins_are_read_from_the_evalonly_block_not_restated():
    data = json.loads(g.PINS_PATH.read_text(encoding="utf-8"))["evalOnly"][g.MODEL_NAME]
    assert g.PINS.model_id == data["modelId"]
    assert g.PINS.revision == data["revision"]
    assert g.PINS.dim == 768 == data["dimensions"]
    assert set(g.PINS.files) >= set(g.REQUIRED_FILES)
    assert all(re.fullmatch(r"[0-9a-f]{64}", h) for h in g.PINS.files.values())


def test_the_script_restates_no_pinned_literal():
    source = SCRIPT.read_text(encoding="utf-8")
    assert not re.search(r"\b[0-9a-f]{40}\b|\b[0-9a-f]{64}\b", source)
    assert g.PINS.model_id not in source


def test_load_pins_refuses_a_pooling_it_does_not_implement(tmp_path):
    p = _pins_file(tmp_path, lambda model: model.update(pooling="cls"))
    with pytest.raises(SystemExit, match="'mean' only"):
        g.load_pins(p)


def test_load_pins_refuses_a_format_it_does_not_load(tmp_path):
    p = _pins_file(tmp_path, lambda model: model.update(format="onnx"))
    with pytest.raises(SystemExit, match="safetensors"):
        g.load_pins(p)


def test_load_pins_refuses_a_width_other_than_768(tmp_path):
    p = _pins_file(tmp_path, lambda model: model.update(dimensions=512))
    with pytest.raises(SystemExit, match="768"):
        g.load_pins(p)


def test_load_pins_refuses_an_unknown_name_and_lists_what_exists():
    with pytest.raises(SystemExit, match="no model 'nope'.*embeddinggemma-2"):
        g.load_pins(g.PINS_PATH, name="nope")


def test_load_pins_refuses_a_missing_required_file(tmp_path):
    p = _pins_file(
        tmp_path,
        lambda model: model.update(
            files=[f for f in model["files"] if f["path"] != "tokenizer.json"]
        ),
    )
    with pytest.raises(SystemExit, match="does not pin.*tokenizer.json"):
        g.load_pins(p)


def test_verify_pins_accepts_matching_bytes_and_rejects_a_drifted_file(tmp_path):
    blob = tmp_path / "f.bin"
    blob.write_bytes(b"pinned bytes")
    good = g.Pins("org/model", "rev", 768, {"f.bin": g.hashlib.sha256(b"pinned bytes").hexdigest()})
    assert g.verify_pins(lambda rel: str(blob), good) == {"f.bin": str(blob)}
    drifted = g.Pins("org/model", "rev", 768, {"f.bin": "0" * 64})
    with pytest.raises(SystemExit, match="checksum mismatch for f.bin"):
        g.verify_pins(lambda rel: str(blob), drifted)


def test_check_pooling_and_modules_require_mean_pooling_with_prompt_and_a_normalize(tmp_path):
    g.check_pooling({"pooling_mode_mean_tokens": True, "include_prompt": True})
    with pytest.raises(SystemExit, match="mean pooling"):
        g.check_pooling({"pooling_mode_mean_tokens": False, "include_prompt": True})
    with pytest.raises(SystemExit, match="include_prompt"):
        g.check_pooling({"pooling_mode_mean_tokens": True, "include_prompt": False})
    g.check_modules(
        [
            {"type": "sentence_transformers.sentence_transformer.modules.Transformer"},
            {"type": "sentence_transformers.sentence_transformer.modules.Pooling"},
            {"type": "sentence_transformers.sentence_transformer.modules.Normalize"},
        ]
    )
    with pytest.raises(SystemExit, match="Normalize"):
        g.check_modules([{"type": "sentence_transformers.sentence_transformer.modules.Pooling"}])


# --- precision ---------------------------------------------------------------------------------


def test_fp16_is_refused_with_the_model_card_reason():
    with pytest.raises(SystemExit, match="float16"):
        g.parse_precision("fp16")


@pytest.mark.parametrize("value", ["bf16", "fp32"])
def test_bf16_and_fp32_are_the_only_accepted_precisions(value):
    assert g.parse_precision(value) == value


def test_unknown_precision_is_refused():
    with pytest.raises(SystemExit, match="precision must be"):
        g.parse_precision("int8")


# --- dims --------------------------------------------------------------------------------------


def test_parse_dims_keeps_order_and_drops_duplicates():
    assert g.parse_dims("768,256") == (768, 256)
    assert g.parse_dims("256,256") == (256,)


@pytest.mark.parametrize("value", ["fp16", "300", "1024", ""])
def test_parse_dims_refuses_what_is_not_an_mrl_dim(value):
    with pytest.raises(SystemExit):
        g.parse_dims(value)


# --- truncate_normalize -------------------------------------------------------------------------


def _rows(n: int = 5, width: int = 768, seed: int = 1) -> np.ndarray:
    return np.random.default_rng(seed).standard_normal((n, width)).astype(np.float32)


def test_truncate_normalize_gives_unit_rows_at_every_mrl_dim_below_the_input_width():
    arr = _rows()
    for dim in (256, 128):
        out = g.truncate_normalize(arr, dim)
        assert out.dtype == np.float32 and out.shape == (5, dim)
        assert np.allclose(np.linalg.norm(out, axis=1), 1.0, atol=1e-6)


def test_truncate_normalize_equals_the_normalized_slice():
    arr = _rows()
    sliced = arr[:, :256]
    want = sliced / np.linalg.norm(sliced, axis=1, keepdims=True)
    assert np.allclose(g.truncate_normalize(arr, 256), want, atol=1e-6)


def test_truncate_normalize_at_768_is_a_renormalizing_passthrough():
    arr = _rows()
    out = g.truncate_normalize(arr, 768)
    assert np.allclose(np.linalg.norm(out, axis=1), 1.0, atol=1e-6)
    assert np.allclose(out, arr / np.linalg.norm(arr, axis=1, keepdims=True), atol=1e-6)


@pytest.mark.parametrize("dim", [300, 1024])
def test_truncate_normalize_rejects_a_dim_outside_the_mrl_set(dim):
    with pytest.raises(SystemExit, match="MRL"):
        g.truncate_normalize(_rows(), dim)


def test_truncate_normalize_rejects_a_zero_row_instead_of_returning_nan():
    arr = _rows()
    arr[2, :] = 0.0
    with pytest.raises(SystemExit, match="zero"):
        g.truncate_normalize(arr, 256)


# --- check_finite -------------------------------------------------------------------------------


@pytest.mark.parametrize("bad", [np.nan, np.inf, -np.inf])
def test_check_finite_names_the_stage_on_nan_or_inf(bad):
    arr = np.ones((2, 4), dtype=np.float32)
    arr[1, 2] = bad
    with pytest.raises(SystemExit, match="batch 7"):
        g.check_finite(arr, "batch 7")


def test_check_finite_passes_clean_input():
    g.check_finite(np.ones((2, 4), dtype=np.float32), "clean")


# --- embed against a fake model ------------------------------------------------------------------


class FakeModel:
    """SentenceTransformer-shaped: encode() returns a fixed unit-row table looked up by the text's
    index ("t7" -> row 7), and records the keyword arguments it was called with."""

    def __init__(self, n: int):
        self.table = _rows(n, 768, seed=9)
        self.table /= np.linalg.norm(self.table, axis=1, keepdims=True)
        self.calls: list[dict] = []

    def encode(self, texts, **kwargs):
        self.calls.append(kwargs)
        return self.table[[int(t[1:]) for t in texts]]


def _embedder(n: int) -> tuple[object, FakeModel]:
    e = g.Embedder()
    e.model = FakeModel(n)
    return e, e.model


def test_embed_returns_packed_float32_per_dim_in_input_order():
    texts = ["t3", "t0", "t9", "t1"]
    e, model = _embedder(10)
    out = e.embed(texts, [768, 256])
    got768 = np.frombuffer(out[768], dtype="<f4").reshape(4, 768)
    got256 = np.frombuffer(out[256], dtype="<f4").reshape(4, 256)
    assert np.allclose(got768, model.table[[3, 0, 9, 1]], atol=1e-6)
    assert np.allclose(got256, g.truncate_normalize(got768, 256), atol=1e-6)
    assert out["n"] == 4 and out["chars"] == sum(len(t) for t in texts)
    assert out["ms"] >= 0


def test_embed_passes_no_prompt_and_normalizes_in_the_model():
    e, model = _embedder(3)
    e.embed(["t0", "t1"], [768])
    (kwargs,) = model.calls
    assert kwargs["normalize_embeddings"] is True
    assert "prompt" not in kwargs and "prompt_name" not in kwargs


def test_embed_refuses_a_non_finite_model_output():
    e, model = _embedder(2)
    model.table[1, 5] = np.nan
    with pytest.raises(SystemExit, match="embed"):
        e.embed(["t0", "t1"], [768])


# --- output file contract ------------------------------------------------------------------------


def _blob(n: int, dim: int = 768, fill: float = 1.0) -> bytes:
    return np.full((n, dim), fill, dtype="<f4").tobytes()


def test_write_vectors_writes_the_complete_file_and_leaves_no_partial(tmp_path):
    out = tmp_path / "vecs-256.f32"
    n = g.write_vectors(str(out), [_blob(2, 256), _blob(1, 256)], [2, 1], 256)
    assert n == 3
    assert out.stat().st_size == 3 * 256 * 4
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
        g.write_vectors(str(out), blobs, sizes, 768)
    assert out.read_bytes() == b"previous complete run"
    assert not Path(f"{out}.partial").exists()


def test_write_embeddings_writes_one_file_per_dim_and_the_query_ids_in_order(tmp_path):
    results = [{768: _blob(2), 256: _blob(2, 256)}, {768: _blob(1), 256: _blob(1, 256)}]
    prefix = str(tmp_path / "qv")
    assert g.write_embeddings(prefix, results, [2, 1], (768, 256)) == 3
    assert Path(f"{prefix}-768.f32").stat().st_size == 3 * 768 * 4
    assert Path(f"{prefix}-256.f32").stat().st_size == 3 * 256 * 4
    g.write_query_ids(prefix, ["q-b", "q-a", "q-c"])
    ids = Path(f"{prefix}-ids.json").read_text(encoding="utf-8")
    assert json.loads(ids) == ["q-b", "q-a", "q-c"]


# --- input, sharding and the run log --------------------------------------------------------------


def test_read_rows_refuses_an_empty_file_and_keeps_keys_and_texts_in_order(tmp_path):
    empty = tmp_path / "empty.jsonl"
    empty.write_text("\n", encoding="utf-8")
    with pytest.raises(SystemExit, match="held no rows"):
        g.read_rows(str(empty), "key")
    rows = tmp_path / "q.jsonl"
    rows.write_text('{"key": "b", "text": "x"}\n{"key": "a", "text": "y"}\n', encoding="utf-8")
    assert g.read_rows(str(rows), "key") == (["b", "a"], ["x", "y"])


def test_plan_shards_cuts_per_call_chunks_in_order():
    shards = g.plan_shards([str(i) for i in range(600)])
    assert [len(s) for s in shards] == [g.PER_CALL, g.PER_CALL, 600 - 2 * g.PER_CALL]
    assert [t for s in shards for t in s] == [str(i) for i in range(600)]


def test_build_log_has_the_contract_keys_and_shards_sum_to_n_texts():
    stats = [{"n": 256, "chars": 900, "ms": 12.5}, {"n": 44, "chars": 100, "ms": 3.0}]
    query = [{"n": 2, "chars": 20, "ms": 1.0}]
    log = g.build_log(g.PINS, "bf16", (768, 256), stats, query, 4.2, "2026-10-28T00:00:00+00:00")
    assert set(log) == {
        "model_id",
        "revision",
        "precision",
        "dims",
        "n_texts",
        "n_queries",
        "shards",
        "gpu_ms_total",
        "wall_s",
        "started_at_utc",
    }
    assert log["model_id"] == g.PINS.model_id and log["revision"] == g.PINS.revision
    assert log["dims"] == [768, 256]
    assert sum(s["n"] for s in log["shards"]) == log["n_texts"] == 300
    assert log["n_queries"] == 2
    assert log["gpu_ms_total"] == pytest.approx(16.5)
