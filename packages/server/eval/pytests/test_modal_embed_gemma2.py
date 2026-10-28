"""Unit tests for eval/modal_embed_gemma2.py: pins, MRL truncation, the float16 refusal, the
load-time pipeline checks, the embed contract, the run arguments and the output file contract.
Everything is mocked; no GPU, torch or modal."""

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


def test_required_files_include_the_processor_and_chat_template_the_loader_reads():
    # ST 6.2.0 loads through AutoProcessor (tokenizer_config names EmbeddingGemma2Processor) and
    # sends every string through apply_chat_template, so these three files shape the token stream.
    needed = {"processor_config.json", "preprocessor_config.json", "chat_template.jinja"}
    assert needed <= set(g.REQUIRED_FILES)
    assert needed <= set(g.PINS.files)


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


# --- the pinned pipeline, checked on the files and on the loaded model ---------------------------


def test_check_pooling_and_modules_require_mean_pooling_with_prompt_and_a_last_normalize():
    # The pinned google/embeddinggemma-2 1_Pooling/config.json, as a dict (sentence-transformers 6
    # writes `pooling_mode`, not the older `pooling_mode_*_tokens` booleans). The first Modal run on
    # 2026-10-28 died on this exact file with "does not declare mean pooling".
    g.check_pooling({"embedding_dimension": 768, "pooling_mode": "mean", "include_prompt": True})
    # The older boolean form (nomic's card) is still mean pooling.
    g.check_pooling({"pooling_mode_mean_tokens": True, "include_prompt": True})
    with pytest.raises(SystemExit, match="mean pooling"):
        g.check_pooling({"pooling_mode": "cls", "include_prompt": True})
    with pytest.raises(SystemExit, match="mean pooling"):
        g.check_pooling({"pooling_mode_mean_tokens": False, "include_prompt": True})
    with pytest.raises(SystemExit, match="include_prompt"):
        g.check_pooling({"pooling_mode": "mean", "include_prompt": False})
    g.check_modules(
        [
            {"type": "sentence_transformers.base.modules.transformer.Transformer"},
            {"type": "sentence_transformers.sentence_transformer.modules.pooling.Pooling"},
            {"type": "sentence_transformers.base.modules.normalize.Normalize"},
        ]
    )
    with pytest.raises(SystemExit, match="Normalize"):
        g.check_modules(
            [{"type": "sentence_transformers.sentence_transformer.modules.pooling.Pooling"}]
        )
    # Present but not last is not the pipeline the model card specifies.
    with pytest.raises(SystemExit, match="end in a Normalize"):
        g.check_modules(
            [
                {"type": "sentence_transformers.base.modules.normalize.Normalize"},
                {"type": "sentence_transformers.sentence_transformer.modules.pooling.Pooling"},
            ]
        )


class _Module:
    def __init__(self, **attrs):
        self.__dict__.update(attrs)


class Normalize(_Module):
    """Named like sentence-transformers' Normalize: the loaded check looks at the class name."""


def _loaded(pooling_mode="mean", include_prompt=True, last=None):
    pooling = _Module(pooling_mode=pooling_mode, include_prompt=include_prompt)
    return [_Module(), pooling, last if last is not None else Normalize()]


def test_loaded_pipeline_must_be_mean_pooling_with_prompt_and_a_last_normalize():
    g.check_loaded_pipeline(_loaded())
    with pytest.raises(SystemExit, match="'cls'"):
        g.check_loaded_pipeline(_loaded(pooling_mode="cls"))
    with pytest.raises(SystemExit, match="include_prompt"):
        g.check_loaded_pipeline(_loaded(include_prompt=False))
    with pytest.raises(SystemExit, match="Normalize"):
        g.check_loaded_pipeline(_loaded(last=_Module()))


# --- image pins ---------------------------------------------------------------------------------


def test_image_pins_pair_torchvision_and_pillow_with_torch():
    pins = dict(p.split("==", 1) for p in g.IMAGE_PACKAGES)
    assert pins["torch"] == "2.15.0"
    assert pins["torchvision"] == "0.29.2"
    assert pins["pillow"] == "13.0.0"
    assert all(v for v in pins.values())


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


# --- run arguments ------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("texts", "out", "queries", "qout"),
    [
        ("t.jsonl", "vecs", None, None),  # docs only
        (None, None, "q.jsonl", "qvecs"),  # queries only
        ("t.jsonl", "vecs", "q.jsonl", "qvecs"),  # both
    ],
)
def test_run_arguments_accept_each_valid_shape(texts, out, queries, qout):
    g.check_run_args(texts, out, queries, qout)


@pytest.mark.parametrize(
    ("texts", "out", "queries", "qout", "msg"),
    [
        (None, None, None, None, "at least one"),  # neither
        ("t.jsonl", None, None, None, "--out-prefix"),  # docs without a prefix
        (None, "vecs", None, None, "--texts"),  # prefix without docs
        (None, None, "q.jsonl", None, "--qout-prefix"),  # queries without a prefix
        ("t.jsonl", "same", "q.jsonl", "same", "differ"),  # both prefixes the same file set
    ],
)
def test_run_arguments_refuse_the_other_shapes(texts, out, queries, qout, msg):
    with pytest.raises(SystemExit, match=msg):
        g.check_run_args(texts, out, queries, qout)


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


# --- check_finite and to_float32 ----------------------------------------------------------------


@pytest.mark.parametrize("bad", [np.nan, np.inf, -np.inf])
def test_check_finite_names_the_stage_on_nan_or_inf(bad):
    arr = np.ones((2, 4), dtype=np.float32)
    arr[1, 2] = bad
    with pytest.raises(SystemExit, match="batch 7"):
        g.check_finite(arr, "batch 7")


def test_check_finite_passes_clean_input():
    g.check_finite(np.ones((2, 4), dtype=np.float32), "clean")


class FakeTensor:
    """Torch-shaped: .float() and .cpu() return the tensor, .numpy() gives the float32 values."""

    def __init__(self, values: np.ndarray):
        self.values = values

    def float(self):
        return self

    def cpu(self):
        return self

    def numpy(self):
        return self.values


def test_to_float32_casts_a_tensor_like_object_and_passes_arrays_through():
    values = np.arange(6, dtype=np.float64).reshape(2, 3)
    out = g.to_float32(FakeTensor(values))
    assert out.dtype == np.float32 and np.array_equal(out, values.astype(np.float32))
    assert g.to_float32(values).dtype == np.float32


# --- embed against a fake model ------------------------------------------------------------------


class FakeTokenizer:
    """HF-tokenizer-shaped: called on a list of texts, returns {"input_ids": ...} with one id list
    per text. A text named in `lengths` gets that many ids; any other text gets one."""

    def __init__(self, lengths: dict[str, int] | None = None):
        self.lengths = lengths or {}
        self.calls: list[dict] = []

    def __call__(self, texts, **kwargs):
        self.calls.append(kwargs)
        return {"input_ids": [[0] * self.lengths.get(t, 1) for t in texts]}


class FakeModel:
    """SentenceTransformer-shaped: encode() returns a fixed unit-row table looked up by the text's
    index ("t7" -> row 7), and records the keyword arguments it was called with."""

    def __init__(self, n: int):
        self.table = _rows(n, 768, seed=9)
        self.table /= np.linalg.norm(self.table, axis=1, keepdims=True)
        self.calls: list[dict] = []
        self.tokenizer = FakeTokenizer()

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


def test_embed_passes_no_prompt_normalizes_in_the_model_and_uses_the_small_batch():
    e, model = _embedder(3)
    e.embed(["t0", "t1"], [768])
    (kwargs,) = model.calls
    assert kwargs["normalize_embeddings"] is True
    assert kwargs["batch_size"] == 32
    assert "prompt" not in kwargs and "prompt_name" not in kwargs


def test_embed_refuses_a_non_finite_model_output():
    e, model = _embedder(2)
    model.table[1, 5] = np.nan
    with pytest.raises(SystemExit, match="embed"):
        e.embed(["t0", "t1"], [768])


def test_embed_counts_the_inputs_the_model_will_cut_with_its_own_tokenizer():
    e, model = _embedder(10)
    model.tokenizer = FakeTokenizer({"t1": g.MAX_SEQ_LENGTH + 1, "t2": g.MAX_SEQ_LENGTH})
    out = e.embed(["t0", "t1", "t2"], [768])
    assert out["truncated"] == 1  # t2 is exactly the limit and is not cut
    assert model.tokenizer.calls == [{"truncation": False}]


def test_embed_refuses_a_model_with_no_tokenizer_to_count_truncation_with():
    e, model = _embedder(2)
    model.tokenizer = None
    with pytest.raises(SystemExit, match="tokenizer"):
        e.embed(["t0", "t1"], [768])


# --- output file contract ------------------------------------------------------------------------


def _rows_blob(first: int, n: int, dim: int) -> bytes:
    """n rows whose first component is first, first+1, ...: any reordering shows up on read-back."""
    arr = np.zeros((n, dim), dtype="<f4")
    arr[:, 0] = np.arange(first, first + n, dtype=np.float32)
    return arr.tobytes()


def _shard_results(sizes: list[int], dims: tuple[int, ...]) -> list[dict]:
    """Shard results with distinct rows across the whole run, in shard order."""
    out, first = [], 0
    for n in sizes:
        out.append({d: _rows_blob(first, n, d) for d in dims})
        first += n
    return out


def test_write_run_writes_complete_vectors_and_ids_in_order_and_leaves_no_partial(tmp_path):
    prefix = str(tmp_path / "vecs")
    results = _shard_results([2, 1], (768, 256))
    written = g.write_run([(prefix, results, [2, 1], ["c-b", "c-a", "c-c"])], (768, 256))
    assert written == {prefix: 3}
    for dim in (768, 256):
        out = Path(f"{prefix}-{dim}.f32")
        assert out.stat().st_size == 3 * dim * 4
        rows = np.frombuffer(out.read_bytes(), dtype="<f4").reshape(3, dim)
        assert rows[:, 0].tolist() == [0.0, 1.0, 2.0]
    assert json.loads(Path(f"{prefix}-ids.json").read_text(encoding="utf-8")) == [
        "c-b",
        "c-a",
        "c-c",
    ]
    assert not list(tmp_path.glob("*.partial"))


def test_write_run_writes_docs_and_queries_together(tmp_path):
    docs = str(tmp_path / "g2")
    qs = str(tmp_path / "q2")
    g.write_run(
        [
            (docs, _shard_results([2], (256,)), [2], ["d0", "d1"]),
            (qs, _shard_results([1], (256,)), [1], ["q-only"]),
        ],
        (256,),
    )
    assert Path(f"{docs}-256.f32").stat().st_size == 2 * 256 * 4
    assert Path(f"{qs}-256.f32").stat().st_size == 1 * 256 * 4
    assert json.loads(Path(f"{qs}-ids.json").read_text(encoding="utf-8")) == ["q-only"]


@pytest.mark.parametrize(
    ("sizes", "blob_sizes", "msg"),
    [
        ([2, 1], [1, 1], "expected"),  # a short shard
        ([2, 1], [2], "partial file"),  # a shard never returned
        ([1], [1, 1], "more shards returned"),
    ],
)
def test_write_run_refuses_a_partial_result_and_keeps_the_earlier_good_files(
    tmp_path, sizes, blob_sizes, msg
):
    prefix = str(tmp_path / "vecs")
    Path(f"{prefix}-768.f32").write_bytes(b"previous complete run")
    Path(f"{prefix}-ids.json").write_text('["old"]', encoding="utf-8")
    results = [{768: _rows_blob(0, n, 768)} for n in blob_sizes]
    with pytest.raises(SystemExit, match=msg):
        g.write_run([(prefix, results, sizes, ["x"] * sum(sizes))], (768,))
    assert Path(f"{prefix}-768.f32").read_bytes() == b"previous complete run"
    assert Path(f"{prefix}-ids.json").read_text(encoding="utf-8") == '["old"]'
    assert not list(tmp_path.glob("*.partial"))


def test_write_run_refuses_ids_that_do_not_match_the_vectors(tmp_path):
    prefix = str(tmp_path / "vecs")
    with pytest.raises(SystemExit, match="ids"):
        g.write_run([(prefix, _shard_results([2], (768,)), [2], ["only-one"])], (768,))
    assert not list(tmp_path.glob("vecs*"))


def test_a_failure_on_the_second_width_publishes_nothing_new(tmp_path):
    prefix = str(tmp_path / "vecs")
    Path(f"{prefix}-768.f32").write_bytes(b"old 768")
    Path(f"{prefix}-256.f32").write_bytes(b"old 256")
    Path(f"{prefix}-ids.json").write_text('["old"]', encoding="utf-8")
    results = [{768: _rows_blob(0, 2, 768), 256: _rows_blob(0, 1, 256)}]  # 256 is one row short
    with pytest.raises(SystemExit, match="expected"):
        g.write_run([(prefix, results, [2], ["a", "b"])], (768, 256))
    assert Path(f"{prefix}-768.f32").read_bytes() == b"old 768"
    assert Path(f"{prefix}-256.f32").read_bytes() == b"old 256"
    assert Path(f"{prefix}-ids.json").read_text(encoding="utf-8") == '["old"]'
    assert not list(tmp_path.glob("*.partial"))


def test_write_run_publishes_the_log_with_the_vectors_or_not_at_all(tmp_path):
    prefix = str(tmp_path / "vecs")
    log = tmp_path / "log.json"
    g.write_run(
        [(prefix, _shard_results([1], (768,)), [1], ["a"])], (768,), [(str(log), '{"n": 1}\n')]
    )
    assert log.read_text(encoding="utf-8") == '{"n": 1}\n'
    assert not list(tmp_path.glob("*.partial"))


def test_a_failed_run_publishes_no_log_and_keeps_the_old_one(tmp_path):
    prefix = str(tmp_path / "vecs")
    log = tmp_path / "log.json"
    log.write_text("old log", encoding="utf-8")
    results = [{768: _rows_blob(0, 1, 768)}]  # one row for two ids: a short shard
    with pytest.raises(SystemExit, match="expected"):
        g.write_run([(prefix, results, [2], ["a", "b"])], (768,), [(str(log), "new log")])
    assert log.read_text(encoding="utf-8") == "old log"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["log.json"]


def test_a_text_write_that_dies_midway_leaves_no_partial_behind(tmp_path, monkeypatch):
    prefix = str(tmp_path / "vecs")
    real_write_text = Path.write_text

    def dies_midway(self, data, *args, **kwargs):
        real_write_text(self, data[:2], *args, **kwargs)
        raise OSError("disk full")

    monkeypatch.setattr(Path, "write_text", dies_midway)
    with pytest.raises(OSError, match="disk full"):
        g.write_run([(prefix, _shard_results([1], (768,)), [1], ["a"])], (768,))
    assert not list(tmp_path.glob("*.partial"))
    assert not list(tmp_path.glob("vecs*"))


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
    stats = [
        {"n": 256, "chars": 900, "ms": 12.5, "truncated": 1},
        {"n": 44, "chars": 100, "ms": 3.0, "truncated": 0},
    ]
    query = [{"n": 2, "chars": 20, "ms": 1.0, "truncated": 0}]
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
        "truncated_inputs",
    }
    assert log["model_id"] == g.PINS.model_id and log["revision"] == g.PINS.revision
    assert log["dims"] == [768, 256]
    assert sum(s["n"] for s in log["shards"]) == log["n_texts"] == 300
    assert log["n_queries"] == 2
    assert log["truncated_inputs"] == 1
    assert log["gpu_ms_total"] == pytest.approx(16.5)
