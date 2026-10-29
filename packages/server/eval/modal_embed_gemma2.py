"""Embed exported chunk texts (and queries) with EmbeddingGemma 2 on one Modal GPU, in bf16 or fp32.

Eval only. The pin is the `embeddinggemma-2` entry of the `evalOnly` block in
embedder-model-pins.json (safetensors). This script adds no prefix of its own: the eval harness
decides what each text looks like, and that text is what gets embedded.

    modal run eval/modal_embed_gemma2.py --texts texts.jsonl --out-prefix vecs --dims 768,256
    modal run eval/modal_embed_gemma2.py --queries queries.jsonl --qout-prefix qvecs --dims 768,256
    modal run eval/modal_embed_gemma2.py --texts texts.jsonl --out-prefix vecs \\
        --queries queries.jsonl --qout-prefix qvecs --dims 768,256

PRECISION RULE. The model card runs EmbeddingGemma 2 in bfloat16 or float32 only. float16 returns
NaN or silently degraded vectors, so `fp16` is refused here (parse_precision), and every batch is
checked for NaN and Inf in every precision (check_finite): a bad dtype fails loudly instead of
shipping vectors.

LOAD RULE. Text-only: `config_kwargs={"vision_config": None, "audio_config": None}` on
SentenceTransformer. The snapshot's files are sha256-checked against the pins (verify_pins). The
loaded pipeline must be mean pooling with include_prompt, ending in an L2 Normalize, the pipeline
the model card specifies (check_loaded_pipeline).

PREFIX RULE. The harness supplies every text already prefixed (`title: <title> | text: <breadcrumb>`
for documents, `task: search result | query: <q>` for queries; see documentText in
eval/embedder-arms-lib.ts), so `embed` passes NO `prompt` or `prompt_name` to encode(). Adding one
here would make these vectors disagree with the harness's own query side.

OUTPUT CONTRACT. For each requested width (MRL 768/512/256/128, re-normalised after truncation):
raw little-endian float32 at `<out-prefix>-<dim>.f32`, N*dim, in the input's line order, and the
chunk ids of those rows at `<out-prefix>-ids.json`. Queries get the same pair under `--qout-prefix`,
with their keys in place of chunk ids. Every file of one run appears together and only when all of
them are complete (`.partial`, then rename). --log is published in that same group: the model,
revision, precision, shard timings, GPU time and `truncated_inputs` (inputs the model cut at
MAX_SEQ_LENGTH).

WHY THE PINS COME FROM JSON. The model id, revision and file hashes are NOT in this file. They are
read from the `evalOnly` block of embedder-model-pins.json, and the pins gate scans every
modal_embed_*.py for restated ids and hashes. A checksum mismatch at download time is fatal.

WHY THE TIMER STOPS AFTER to_float32. With convert_to_tensor the result is a tensor that is still
on the GPU, so the work is only finished once it is copied to the host. to_float32 does that copy,
and the per-shard `ms` is taken after it, so it is real GPU time and not the time to queue kernels.

A Modal run costs money and is run by the owner. Wrap each `modal run` in a client-side timeout
shorter than the Embedder's `timeout=3600`, since on 2026-10-28 a hung client kept an A10G billed
until a 25-minute client timeout ended it. CI runs the unit tests in pytests/ (no GPU, no torch).
"""

import hashlib
import json
import os
import time
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import modal

MODEL_NAME = "embeddinggemma-2"
PINS_PATH = Path(__file__).with_name("embedder-model-pins.json")
POOLING = "mean"
FORMAT = "safetensors"
REQUIRED_FILES = (
    "model.safetensors",
    "config.json",
    "tokenizer.json",
    "tokenizer.model",
    "tokenizer_config.json",
    "modules.json",
    "1_Pooling/config.json",
    "2_Normalize/config.json",
    "sentence_bert_config.json",
    "config_sentence_transformers.json",
    # ST 6.2.0 loads through AutoProcessor (tokenizer_config names EmbeddingGemma2Processor), and
    # sends every string through apply_chat_template: these three shape the token stream.
    "processor_config.json",
    "preprocessor_config.json",
    "chat_template.jinja",
)
DIM = 768
# Matryoshka widths the model card lists; anything else is refused rather than silently sliced.
MRL_DIMS = (768, 512, 256, 128)
# Precisions the model card allows. Keys are the CLI names, values the torch dtype attribute names.
TORCH_DTYPE = {"bf16": "bfloat16", "fp32": "float32"}
FLOAT16_NAMES = ("fp16", "float16", "half")
PER_CALL = 256  # texts per remote call, keeps each argument well under Modal's limit
BATCH_SIZE = 32
# ST reports an effectively unbounded max_seq_length for this model (no top-level
# max_position_embeddings), so nothing would truncate. The eval chunks are far shorter than this;
# the cap only stops a runaway input from exhausting the A10G's memory at batch 32.
MAX_SEQ_LENGTH = 2048
READ_BLOCK = 1048576

# Exact pins, so the image is reproducible. torchvision 0.29.2 is the release for torch 2.15 (both
# released 2026-10-28; torchvision 0.29.2 needs torch>=2.14). Pillow and torchvision are imported by
# the multimodal processor even for text-only input, so AutoProcessor fails without them.
IMAGE_PACKAGES = (
    "torch==2.15.0",
    "torchvision==0.29.2",
    "pillow==13.0.0",
    "sentence-transformers==6.2.0",
    "transformers==5.21.0",
    "huggingface-hub==1.33.0",
    "numpy==2.5.3",
)


@dataclass(frozen=True)
class Pins:
    """The slice of embedder-model-pins.json this script runs: one eval-only model."""

    model_id: str
    revision: str
    dim: int
    files: dict[str, str]  # repo-relative path -> sha256


def load_pins(path: Path, name: str = MODEL_NAME) -> Pins:
    """Read the eval-only pins for `name`. Refuses what this script cannot reproduce faithfully."""
    evals = json.loads(path.read_text(encoding="utf-8"))["evalOnly"]
    if name not in evals:
        raise SystemExit(f"{path.name} has no model {name!r} in evalOnly; has {sorted(evals)}")
    m = evals[name]
    if m["pooling"] != POOLING:
        raise SystemExit(
            f"{name} declares {m['pooling']!r} pooling; this script implements {POOLING!r} only"
        )
    if m["format"] != FORMAT:
        raise SystemExit(f"{name} is in {m['format']!r} format; this script loads {FORMAT!r} only")
    if int(m["dimensions"]) != DIM:
        raise SystemExit(f"{name} declares {m['dimensions']} dimensions; this script serves {DIM}")
    files = {f["path"]: f["sha256"] for f in m["files"]}
    missing = [p for p in REQUIRED_FILES if p not in files]
    if missing:
        raise SystemExit(f"{path.name}: {name} does not pin {missing}")
    return Pins(m["modelId"], m["revision"], int(m["dimensions"]), files)


PINS = load_pins(PINS_PATH)

app = modal.App("otc-embed-gemma2")
image = (
    modal.Image.debian_slim(python_version="3.12")
    .uv_pip_install(*IMAGE_PACKAGES)
    # The Hugging Face cache lives on the Volume below, so the 1.5 GB safetensors download once.
    .env({"HF_HOME": "/cache/hf"})
    # Mounted beside this module (Modal places the entrypoint at /root), so PINS_PATH resolves the
    # same way here as in the container.
    .add_local_file(PINS_PATH, f"/root/{PINS_PATH.name}")
)
hf_cache = modal.Volume.from_name("otc-hf-cache", create_if_missing=True)


# --- pure logic: no GPU, no modal; unit-tested in pytests/ --------------------------------------
# sha256_file and verify_pins are copied from modal_embed_nomic.py. Importing that module inside
# this container would need its own source added to the image, and the copy is the simpler
# contract; pytests/test_modal_embed_gemma2.py covers these copies directly.


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(READ_BLOCK), b""):
            h.update(block)
    return h.hexdigest()


def verify_pins(download: Callable[[str], str], pins: Pins) -> dict[str, str]:
    """Download every pinned file and check its sha256. Returns repo-relative path -> local path.

    A mismatch means the pin moved on one side only -- a hard failure, not a warning."""
    paths: dict[str, str] = {}
    for rel, want in pins.files.items():
        local = download(rel)
        got = sha256_file(local)
        if got != want:
            raise SystemExit(
                f"checksum mismatch for {rel}: expected {want}, got {got}. "
                "The eval pin and the downloaded file disagree -- do not use these vectors."
            )
        paths[rel] = local
    return paths


def check_pooling(cfg: dict) -> None:
    """The model card's pooling: mean over tokens, prompt tokens included. sentence-transformers 6
    writes `"pooling_mode": "mean"`; older cards write `"pooling_mode_mean_tokens": true`."""
    mean = cfg.get("pooling_mode") == "mean" or cfg.get("pooling_mode_mean_tokens") is True
    if not mean:
        raise SystemExit("1_Pooling/config.json does not declare mean pooling")
    if cfg.get("include_prompt") is not True:
        raise SystemExit(
            "1_Pooling/config.json has include_prompt false; the model card needs true"
        )


def check_modules(modules: Sequence[dict]) -> None:
    """modules.json must have a Pooling module and end in a Normalize, the L2 step the model card's
    pipeline ends with."""
    types = [m["type"] for m in modules]
    if not any(t.endswith(".Pooling") for t in types):
        raise SystemExit("modules.json has no Pooling module")
    if not types or not types[-1].endswith(".Normalize"):
        raise SystemExit("modules.json must end in a Normalize module")


def check_loaded_pipeline(modules: Any) -> None:
    """The same pipeline, checked on the objects sentence-transformers built (`modules[1]` is the
    Pooling, `modules[-1]` the Normalize), not only on the JSON files."""
    if len(modules) < 2:
        raise SystemExit(
            f"loaded model has {len(modules)} modules; expected Transformer, Pooling, ..."
        )
    pooling = modules[1]
    mode = getattr(pooling, "pooling_mode", None)
    if mode != POOLING:
        raise SystemExit(f"loaded Pooling is {mode!r} pooling, not {POOLING!r}")
    if getattr(pooling, "include_prompt", None) is not True:
        raise SystemExit("loaded Pooling has include_prompt false; the model card needs true")
    last = type(modules[-1]).__name__
    if last != "Normalize":
        raise SystemExit(f"loaded pipeline ends in {last!r}, not a Normalize")


def parse_precision(value: str) -> str:
    """bf16 or fp32. float16 is refused with the model card's reason, because it is the one
    dtype the model is documented to break under."""
    if value in TORCH_DTYPE:
        return value
    if value in FLOAT16_NAMES:
        raise SystemExit(
            "float16 is refused: EmbeddingGemma 2 returns NaN or silently degraded vectors in "
            "float16 (model card). Use bf16 or fp32."
        )
    raise SystemExit(f"precision must be one of {sorted(TORCH_DTYPE)}, got {value!r}")


def parse_dims(value: str) -> tuple[int, ...]:
    """'768,256' -> (768, 256); de-duplicated, order kept; anything outside MRL_DIMS is refused."""
    dims: list[int] = []
    for part in value.split(","):
        try:
            d = int(part.strip())
        except ValueError:
            raise SystemExit(f"dims must be integers from {MRL_DIMS}, got {part!r}") from None
        if d not in MRL_DIMS:
            raise SystemExit(f"dim {d} is not an MRL width; use one of {MRL_DIMS}")
        dims.append(d)
    return tuple(dict.fromkeys(dims))


def check_run_args(
    texts: str | None, out_prefix: str | None, queries: str | None, qout_prefix: str | None
) -> None:
    """Documents, queries or both. Each input needs its prefix, each prefix its input, and the two
    prefixes must name different outputs."""
    if texts is None and queries is None:
        raise SystemExit("give at least one of --texts / --queries")
    if (texts is None) != (out_prefix is None):
        raise SystemExit("--texts and --out-prefix go together")
    if (queries is None) != (qout_prefix is None):
        raise SystemExit("--queries and --qout-prefix go together")
    if out_prefix is not None and out_prefix == qout_prefix:
        raise SystemExit("--out-prefix and --qout-prefix must differ")


def truncate_normalize(arr: Any, dim: int) -> Any:
    """Matryoshka truncation: keep the first `dim` components, then L2-normalise each row again.

    float32 in, float32 out. A zero row (after slicing) is an error, not a NaN."""
    import numpy as np

    if dim not in MRL_DIMS:
        raise SystemExit(f"dim {dim} is not an MRL width; use one of {MRL_DIMS}")
    if dim > arr.shape[1]:
        raise SystemExit(f"dim {dim} is wider than the {arr.shape[1]}-wide input")
    sliced = np.asarray(arr[:, :dim], dtype=np.float32)
    norms = np.linalg.norm(sliced, axis=1, keepdims=True)
    if np.any(norms <= 0):
        raise SystemExit(f"zero row at {dim} dims: cannot normalise it")
    return (sliced / norms).astype(np.float32)


def check_finite(arr: Any, where: str) -> None:
    """NaN or Inf anywhere is a failed batch. This is the float16 failure mode made loud."""
    import numpy as np

    if not np.isfinite(arr).all():
        raise SystemExit(f"{where}: non-finite values (NaN/Inf) in the embeddings; refusing them")


def to_float32(vecs: Any) -> Any:
    """A torch tensor (from convert_to_tensor) becomes a float32 numpy array: .float() casts bf16
    up, and .cpu() is where the GPU work is waited for."""
    import numpy as np

    if hasattr(vecs, "cpu"):
        vecs = vecs.float().cpu().numpy()
    return np.asarray(vecs, dtype=np.float32)


def read_rows(path: str, key: str) -> tuple[list[str], list[str]]:
    """(keys, texts) from a JSONL file, in line order. An empty file is refused."""
    keys: list[str] = []
    texts: list[str] = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                row = json.loads(line)
                keys.append(row[key])
                texts.append(row["text"])
    if not texts:
        raise SystemExit(f"{path} held no rows")
    return keys, texts


def plan_shards(texts: Sequence[str], per_call: int = PER_CALL) -> list[list[str]]:
    return [list(texts[i : i + per_call]) for i in range(0, len(texts), per_call)]


def stage_vectors(out: str, blobs: Iterable[bytes], shard_sizes: Sequence[int], dim: int) -> str:
    """Write the shards' packed float32 vectors to `<out>.partial` and return that path.

    `blobs` must arrive in shard order; each must be exactly shard_sizes[i] * dim * 4 bytes. A
    short, missing or extra shard removes the partial and refuses, so nothing is left to be mistaken
    for a result."""
    partial = f"{out}.partial"
    n = 0
    try:
        with open(partial, "wb") as fh:
            for i, blob in enumerate(blobs):
                if i >= len(shard_sizes):
                    raise SystemExit(f"more shards returned than the {len(shard_sizes)} sent")
                want = shard_sizes[i] * dim * 4
                if len(blob) != want:
                    raise SystemExit(
                        f"shard {i}: got {len(blob)} bytes, expected {want} "
                        f"({shard_sizes[i]} vectors of {dim} float32)"
                    )
                fh.write(blob)
                n += shard_sizes[i]
        total = sum(shard_sizes)
        if n != total:
            raise SystemExit(f"wrote {n} vectors for {total} texts -- refusing a partial file")
    except BaseException:
        if os.path.exists(partial):
            os.remove(partial)
        raise
    return partial


def count_truncated(model: Any, texts: Sequence[str]) -> int:
    """How many of `texts` the model cuts at MAX_SEQ_LENGTH, counted with the model's own tokenizer.
    A cut input is a vector of a text it does not describe, so the count goes in the log; without a
    tokenizer there is no count, and no run."""
    tokenizer = getattr(model, "tokenizer", None)
    if tokenizer is None:
        raise SystemExit("the loaded model has no tokenizer to count truncation with")
    lengths = tokenizer(list(texts), truncation=False)["input_ids"]
    return sum(1 for ids in lengths if len(ids) > MAX_SEQ_LENGTH)


def stage_text(out: str, text: str, staged: list[tuple[str, str]]) -> None:
    """Write `text` to `<out>.partial`. The partial is registered in `staged` BEFORE the write, so a
    write that dies midway is cleaned up with the rest."""
    partial = f"{out}.partial"
    staged.append((partial, out))
    Path(partial).write_text(text, encoding="utf-8")


# (output prefix, the shards' results, shard sizes, the id of each row in order)
RunGroup = tuple[str, Sequence[dict], Sequence[int], Sequence[str]]


def write_run(
    groups: Sequence[RunGroup], dims: Sequence[int], texts: Sequence[tuple[str, str]] = ()
) -> dict[str, int]:
    """Every output of one run, or none.

    For each group this stages `<prefix>-<dim>.f32` for every width and `<prefix>-ids.json`, all as
    `.partial`. The final names appear only after every file has checked out. A failure anywhere
    removes the partials staged so far, so a new file never sits beside a stale one from an earlier
    run. `texts` are (path, content) pairs published in the same run, the run log among them.
    Returns the vector count per prefix."""
    staged: list[tuple[str, str]] = []  # (partial, final)
    try:
        for prefix, results, sizes, ids in groups:
            if len(ids) != sum(sizes):
                raise SystemExit(f"{prefix}: {len(ids)} ids for {sum(sizes)} vectors")
            for dim in dims:
                final = f"{prefix}-{dim}.f32"
                staged.append((stage_vectors(final, (r[dim] for r in results), sizes, dim), final))
            final = f"{prefix}-ids.json"
            stage_text(final, json.dumps(list(ids)), staged)
        for final, text in texts:
            stage_text(final, text, staged)
    except BaseException:
        for partial, _ in staged:
            if os.path.exists(partial):
                os.remove(partial)
        raise
    for partial, final in staged:
        os.replace(partial, final)
    return {prefix: sum(sizes) for prefix, _, sizes, _ in groups}


def build_log(
    pins: Pins,
    precision: str,
    dims: Sequence[int],
    doc_stats: Sequence[dict],
    query_stats: Sequence[dict],
    wall_s: float,
    started_at_utc: str,
) -> dict:
    return {
        "model_id": pins.model_id,
        "revision": pins.revision,
        "precision": precision,
        "dims": list(dims),
        "n_texts": sum(s["n"] for s in doc_stats),
        "n_queries": sum(s["n"] for s in query_stats),
        "shards": list(doc_stats),
        "gpu_ms_total": sum(s["ms"] for s in [*doc_stats, *query_stats]),
        "truncated_inputs": sum(s["truncated"] for s in [*doc_stats, *query_stats]),
        "wall_s": wall_s,
        "started_at_utc": started_at_utc,
    }


# --- Modal ----------------------------------------------------------------------------------------


@app.cls(image=image, gpu="A10G", timeout=3600, max_containers=1, volumes={"/cache": hf_cache})
class Embedder:
    # Set per instance: Embedder(precision="fp32").embed.map(...). Modal's parameter idiom.
    precision: str = modal.parameter(default="bf16")

    @modal.enter()
    def load(self) -> None:
        import torch
        from huggingface_hub import hf_hub_download
        from sentence_transformers import SentenceTransformer

        dtype = getattr(torch, TORCH_DTYPE[parse_precision(self.precision)])
        paths = verify_pins(
            lambda rel: hf_hub_download(PINS.model_id, rel, revision=PINS.revision), PINS
        )
        # Persist the download so the next container reads the Volume instead of the Hub.
        hf_cache.commit()
        snapshot = os.path.dirname(paths["config.json"])
        with open(os.path.join(snapshot, "1_Pooling", "config.json"), encoding="utf-8") as f:
            check_pooling(json.load(f))
        with open(os.path.join(snapshot, "modules.json"), encoding="utf-8") as f:
            check_modules(json.load(f))
        self.model = SentenceTransformer(
            snapshot,
            device="cuda",
            model_kwargs={"dtype": dtype},
            config_kwargs={"vision_config": None, "audio_config": None},
        )
        self.model.max_seq_length = MAX_SEQ_LENGTH
        check_loaded_pipeline(self.model)
        got_dtype = next(self.model.parameters()).dtype
        if got_dtype != dtype:
            raise SystemExit(f"model loaded as {got_dtype}; the precision asked for is {dtype}")
        got = self.model.get_embedding_dimension()
        if got != PINS.dim:
            raise SystemExit(f"model is {got}-wide; the pin says {PINS.dim}")

    @modal.method()
    def embed(self, texts: list[str], dims: list[int]) -> dict:
        """{dim: little-endian float32 bytes in input order} plus ms, n, chars and truncated
        for the log."""
        t0 = time.perf_counter()
        # No prompt: the harness already prefixed every text (see the PREFIX RULE above).
        vecs = self.model.encode(
            texts, batch_size=BATCH_SIZE, normalize_embeddings=True, convert_to_tensor=True
        )
        arr = to_float32(vecs)
        ms = (time.perf_counter() - t0) * 1000.0
        check_finite(arr, "embed")
        out: dict[Any, Any] = {d: truncate_normalize(arr, d).astype("<f4").tobytes() for d in dims}
        out["ms"] = ms
        out["n"] = len(texts)
        out["chars"] = sum(len(t) for t in texts)
        out["truncated"] = count_truncated(self.model, texts)
        return out


@app.local_entrypoint()
def main(
    texts: str | None = None,
    out_prefix: str | None = None,
    dims: str = "768,256",
    precision: str = "bf16",
    queries: str | None = None,
    qout_prefix: str | None = None,
    log: str | None = None,
):
    check_run_args(texts, out_prefix, queries, qout_prefix)
    dim_list = parse_dims(dims)
    precision = parse_precision(precision)
    doc_ids, doc_texts = read_rows(texts, "chunk_id") if texts is not None else ([], [])
    q_keys, q_texts = read_rows(queries, "key") if queries is not None else ([], [])
    doc_shards = plan_shards(doc_texts)
    q_shards = plan_shards(q_texts)
    shards = [*doc_shards, *q_shards]

    started = datetime.now(UTC)
    t0 = time.perf_counter()
    # One map over docs then queries, same instance and precision. .map keeps input order.
    results = list(Embedder(precision=precision).embed.map(shards, [dim_list] * len(shards)))
    wall = time.perf_counter() - t0
    doc_results, q_results = results[: len(doc_shards)], results[len(doc_shards) :]
    stats = [
        {"n": r["n"], "chars": r["chars"], "ms": r["ms"], "truncated": r["truncated"]}
        for r in results
    ]
    doc_stats, query_stats = stats[: len(doc_shards)], stats[len(doc_shards) :]

    groups: list[RunGroup] = []
    if out_prefix is not None:
        groups.append((out_prefix, doc_results, [len(s) for s in doc_shards], doc_ids))
    if qout_prefix is not None:
        groups.append((qout_prefix, q_results, [len(s) for s in q_shards], q_keys))
    texts_out: list[tuple[str, str]] = []
    if log is not None:
        entry = build_log(
            PINS,
            precision,
            dim_list,
            doc_stats,
            query_stats,
            wall,
            started.isoformat(timespec="seconds"),
        )
        texts_out.append((log, json.dumps(entry, indent=2) + "\n"))
    written = write_run(groups, dim_list, texts_out)
    total = sum(written.values())
    truncated = sum(s["truncated"] for s in stats)
    dims_label = "/".join(str(d) for d in dim_list)
    print(
        f"{total} vectors ({dims_label}d {precision}), {truncated} truncated "
        f"-> {', '.join(written)} in {wall:.1f}s ({total / wall:.1f}/s)"
    )
