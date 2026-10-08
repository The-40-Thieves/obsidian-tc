"""Embed every exported chunk text with nomic-embed-text-v1.5 on one Modal GPU.

Runs THE SAME pinned ONNX graph the bundled local embedder runs: same HF repo, same revision, same
onnx/model.onnx, mean pooling, L2 normalization, and -- like it -- NO task prefix. nomic's model
card asks for "search_document: "/"search_query: " prefixes and embedder-local does not apply them
(packages/embedder-local/src/index.ts); adding them HERE only would make these vectors
non-comparable with the ones the query side produces, which is the one thing that must not happen.

Only the execution provider differs: CUDA here, CPU there. Measured on 64 real chunks, GPU vs local
CPU fp32 agreed to max abs component diff 2.9e-07 with identical top-10 neighbours and rank-1, so
what this writes is interchangeable with what `embeddings.provider: "local"` + `quantized: false`
produces at query time. That interchangeability is the whole design -- one provider.id serves both
document and query embedding, so the two sides must be the same function.

    modal run eval/modal_embed_nomic.py --texts texts.jsonl --out vecs.f32

Writes raw little-endian float32, N*768, in the input's line order -- exactly the layout
eval/load-gpu-vecs.ts reads. Pair it with the ids.json eval/export-chunk-texts.ts wrote in the SAME
run; the two files are positionally joined and nothing downstream can detect a mismatch, so ORDER is
the contract: shards are embedded length-sorted for throughput but returned, and written, in input
order. The output appears only when complete: it is written to `<out>.partial` and renamed, so a
crash or a short run leaves no file for the loader to mistake for a result.

NO RESTATED PINS. The model id, revision, width, pooling and file checksums are NOT in this file:
they are read from embedder-model-pins.json, which scripts/check-model-pins.mjs derives from
packages/embedder-local/src/model-info.ts (the one place they are declared) and gates in CI. A
checksum mismatch at download time is fatal.

WHY THE NVIDIA PIP WHEELS AND THE ctypes PRELOAD: unlike eval/modal_rerank_gte.py, this image has
no torch, and torch is what silently supplies CUDA 12 / cuDNN 9 to a debian_slim image. Without
them onnxruntime-gpu cannot dlopen libonnxruntime_providers_cuda.so ("libcublasLt.so.12: cannot
open shared object file") and falls back to CPU -- which for a GPU batch job is a 100x slowdown
that still produces correct-looking output. Preloading RTLD_GLOBAL from nvidia.__path__ satisfies
the provider's link-time deps without guessing a site-packages path or an image registry tag, and
the CUDA assertion turns a silent CPU fallback into a hard failure.

WHY onnxruntime-gpu IS 1.26.0 AND NOT THE NEWEST: since 1.27 the PyPI `onnxruntime-gpu` wheel is
built against CUDA 13 (its `cuda` extra requires nvidia-cuda-runtime~=13 and nvidia-cudnn-cu13).
1.26.0 is the newest release built against CUDA 12 and it ships a cp314 manylinux x86_64 wheel, so
this image is Python 3.14 on the latest CUDA 12 stack (nvidia-*-cu12 12.9.x, cuDNN 9.27). Moving to
1.27+ means moving every nvidia-* pin to its cu13 wheel and re-validating on the T4.
"""

import ctypes
import glob
import hashlib
import json
import os
import time
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import modal

MODEL_NAME = "nomic-embed-text-v1.5"
VARIANT = "fp32"
PINS_PATH = Path(__file__).with_name("embedder-model-pins.json")
# The only pooling this file implements; load_pins refuses a catalog entry that declares another.
POOLING = "mean"
REQUIRED_FILES = ("onnx/model.onnx", "tokenizer.json", "tokenizer_config.json")

READ_BLOCK = 1048576
MAX_BATCH = 32
# Bound on batch_size * seq_len^2, the term attention memory scales with. Twice measured on a 16 GB
# T4: a fixed batch of 64 asked for one 5.6 GB buffer, and a 3e7 budget still asked for 1.31 GB and
# died. 1.31e9/(12 heads * 4 B) back-solves to B*T^2 ~= 27e6, i.e. the budget WAS the binding
# constraint -- ORT keeps several tensors that size live at once, so the budget has to leave room
# for more than one. 8e6 puts the largest single buffer near 384 MB. chunks.token_count is only an
# ESTIMATE (max 524 in this vault); real tokenization of code and URLs runs well above it, which is
# why this is a budget and not a fixed batch, and why forward_split exists underneath it.
ATTN_BUDGET = 8_000_000
PER_CALL = 256  # texts per remote call, keeps each argument well under Modal's limit
# RTLD_GLOBAL preload target, relative to each `nvidia` namespace root. Deliberately EVERY shared
# object rather than a named list: naming them one at a time is whack-a-mole, because the CUDA
# provider's unmet dependency is only reported one library per run (cublasLt, then curand, then...).
CUDA_LIB_GLOB = "*/lib/*.so*"
# RTLD_GLOBAL in glob order can need a retry when one lib depends on another.
PRELOAD_PASSES = 3
OOM_MARKERS = (
    "failed to allocate memory",
    "out of memory",
    "cudaerrormemoryallocation",
)


@dataclass(frozen=True)
class Pins:
    """The slice of embedder-model-pins.json this script runs: one model, one dtype variant."""

    model_id: str
    revision: str
    dim: int
    files: dict[str, str]  # repo-relative path -> sha256


def load_pins(path: Path, name: str = MODEL_NAME, variant: str = VARIANT) -> Pins:
    """Read the pins for `name`/`variant`. Refuses what this script cannot reproduce faithfully."""
    models = json.loads(path.read_text(encoding="utf-8"))["models"]
    if name not in models:
        raise SystemExit(f"{path.name} has no model {name!r}; has {sorted(models)}")
    m = models[name]
    if m["pooling"] != POOLING:
        raise SystemExit(
            f"{name} declares {m['pooling']!r} pooling; this script implements {POOLING!r} only"
        )
    files = {f["path"]: f["sha256"] for f in m["variants"][variant]["files"]}
    missing = [p for p in REQUIRED_FILES if p not in files]
    if missing:
        raise SystemExit(f"{path.name}: {name}/{variant} does not pin {missing}")
    return Pins(m["modelId"], m["revision"], int(m["dimensions"]), files)


PINS = load_pins(PINS_PATH)
DIM = PINS.dim

app = modal.App("otc-embed-nomic")
# Versions: the newest of each that resolves for cp314 / linux x86_64 with onnxruntime-gpu on its
# CUDA 12 line (see the module docstring). Exact pins, so the image is reproducible.
image = (
    modal.Image.debian_slim(python_version="3.14")
    .uv_pip_install(
        "onnxruntime-gpu==1.26.0",
        # The full CUDA 12 runtime set the ORT CUDA provider links against. torch would supply these
        # implicitly (as eval/modal_rerank_gte.py gets for free) at the cost of a ~2.5 GB image.
        "nvidia-cuda-runtime-cu12==12.9.79",
        "nvidia-cuda-nvrtc-cu12==12.9.86",
        "nvidia-cublas-cu12==12.9.2.10",
        "nvidia-cudnn-cu12==9.27.0.42",
        "nvidia-curand-cu12==10.3.10.19",
        "nvidia-cufft-cu12==11.4.1.4",
        "nvidia-cusparse-cu12==12.5.10.65",
        "nvidia-cusolver-cu12==11.7.5.82",
        "nvidia-nvjitlink-cu12==12.9.86",
        "tokenizers==0.23.2",
        "huggingface-hub==1.33.0",
        "numpy==2.5.3",
    )
    # Mounted at startup beside this module (Modal places the entrypoint at /root), so
    # PINS_PATH resolves identically here and in the container.
    .add_local_file(PINS_PATH, f"/root/{PINS_PATH.name}")
)


# --- pure logic: no GPU, no modal; unit-tested in pytests/ with a mock session -------------------


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(READ_BLOCK), b""):
            h.update(block)
    return h.hexdigest()


def verify_pins(download: Callable[[str], str], pins: Pins) -> dict[str, str]:
    """Download every pinned file and check its sha256. Returns repo-relative path -> local path.

    A mismatch means the pin moved on one side only, which is exactly the silent divergence this
    exists to catch -- a hard failure, not a warning."""
    paths: dict[str, str] = {}
    for rel, want in pins.files.items():
        local = download(rel)
        got = sha256_file(local)
        if got != want:
            raise SystemExit(
                f"checksum mismatch for {rel}: expected {want}, got {got}. "
                "model-info.ts's pin and the downloaded file disagree -- do not ship these vectors."
            )
        paths[rel] = local
    return paths


def preload_cuda_libs(
    roots: Iterable[str],
    loader: Callable[..., Any] = ctypes.CDLL,
    passes: int = PRELOAD_PASSES,
) -> int:
    """dlopen every shared object under each `nvidia` root RTLD_GLOBAL; returns how many loaded.

    A lib that fails may load once a dependency of its own is in the namespace, so failures are
    retried for a few passes. Loading nothing is fatal: the CUDA provider cannot dlopen without
    them."""
    candidates: list[str] = []
    for root in roots:
        candidates.extend(sorted(glob.glob(os.path.join(root, CUDA_LIB_GLOB))))
    pending = list(candidates)
    loaded = 0
    for _ in range(passes):
        retry: list[str] = []
        for so in pending:
            try:
                loader(so, mode=ctypes.RTLD_GLOBAL)
                loaded += 1
            except OSError:
                retry.append(so)
        pending = retry
        if not pending:
            break
    if loaded == 0:
        raise SystemExit(
            f"preloaded no CUDA libraries from {len(candidates)} candidate(s) under "
            "nvidia.__path__ -- the CUDA provider cannot dlopen without them; check the "
            "nvidia-*-cu12 wheels are present in the image"
        )
    return loaded


def require_cuda(session: Any) -> None:
    """Refuse to embed on CPU: ORT silently falls back when the CUDA provider fails to load."""
    if "CUDAExecutionProvider" not in session.get_providers():
        raise SystemExit("CUDA execution provider unavailable -- refusing to embed on CPU here")


def plan_batches(
    lengths: Sequence[int], max_batch: int = MAX_BATCH, budget: int = ATTN_BUDGET
) -> list[list[int]]:
    """Group indices into batches of near-equal length under an attention budget.

    Length-sorted (stable) so each batch's padding width is set by a near neighbour, not by the one
    longest chunk in an arbitrary fixed-width window. A batch grows while it holds fewer than
    `max_batch` rows and `rows * longest^2 <= budget`; a single row over budget still gets its own
    batch (it cannot be split further). The batches are a partition of range(len(lengths))."""
    order = sorted(range(len(lengths)), key=lengths.__getitem__)
    batches: list[list[int]] = []
    pos = 0
    while pos < len(order):
        take = 1
        t_max = lengths[order[pos]]
        while take < max_batch and pos + take < len(order):
            cand = max(t_max, lengths[order[pos + take]])
            if cand * cand * (take + 1) > budget:
                break
            t_max = cand
            take += 1
        batches.append(order[pos : pos + take])
        pos += take
    return batches


def is_oom(exc: BaseException) -> bool:
    msg = str(exc).lower()
    return any(k in msg for k in OOM_MARKERS)


def forward_split(
    forward: Callable[[list[int]], Any],
    idx: list[int],
    out: list[Any],
    oom: Callable[[BaseException], bool] = is_oom,
) -> None:
    """forward(idx) into out[i], halving the batch on an allocation failure.

    A budget alone is a guess about how much ORT keeps live at once; this makes a wrong guess cost
    throughput instead of the whole run. Only allocation failures split -- anything else raises
    immediately rather than being retried one row at a time behind a misleading OOM story, and a
    single row that cannot be allocated raises too."""
    try:
        vecs = forward(idx)
    except Exception as e:
        # Only an allocation failure on a still-splittable batch falls through to the halving.
        if not oom(e) or len(idx) == 1:
            raise
        mid = len(idx) // 2
        forward_split(forward, idx[:mid], out, oom)
        forward_split(forward, idx[mid:], out, oom)
        return
    for row, i in enumerate(idx):
        out[i] = vecs[row]


def embed_sequences(
    seqs: Sequence[Sequence[int]],
    forward: Callable[[list[int]], Any],
    max_batch: int = MAX_BATCH,
    budget: int = ATTN_BUDGET,
) -> list[Any]:
    """One vector per sequence, in INPUT order regardless of how batches were formed."""
    out: list[Any] = [None] * len(seqs)
    for batch in plan_batches([len(s) for s in seqs], max_batch, budget):
        forward_split(forward, batch, out)
    missing = sum(1 for v in out if v is None)
    if missing:
        raise SystemExit(f"internal: {missing} text(s) produced no vector")
    return out


def pad_batch(seqs: Sequence[Sequence[int]], idx: list[int], pad_id: int) -> tuple[Any, Any]:
    """Right-pad the rows `idx` to their longest. Returns int64 (ids, mask), shape (len(idx), T)."""
    import numpy as np

    width = max(len(seqs[i]) for i in idx)
    ids = np.full((len(idx), width), pad_id, dtype=np.int64)
    mask = np.zeros((len(idx), width), dtype=np.int64)
    for row, i in enumerate(idx):
        s = seqs[i]
        ids[row, : len(s)] = s
        mask[row, : len(s)] = 1
    return ids, mask


def pool_normalize(hidden: Any, mask: Any) -> Any:
    """Mask-weighted mean over tokens, then L2 normalize -- transformers.js
    `{ pooling: "mean", normalize: true }`, which is what embedder-local passes. Padding rows carry
    zero weight, so manual padding is arithmetically identical to the tokenizer's."""
    import numpy as np

    m = mask.astype(np.float32)[..., None]
    summed = (hidden.astype(np.float32) * m).sum(axis=1)
    counts = np.maximum(m.sum(axis=1), 1e-9)
    mean = summed / counts
    norms = np.maximum(np.linalg.norm(mean, axis=1, keepdims=True), 1e-12)
    return (mean / norms).astype(np.float32)


def make_forward(
    session: Any, input_names: set[str], seqs: Sequence[Sequence[int]], pad_id: int, dim: int
) -> Callable[[list[int]], Any]:
    """The padded forward pass over given indices: (len(idx), dim) float32."""
    import numpy as np

    def forward(idx: list[int]) -> Any:
        ids, mask = pad_batch(seqs, idx, pad_id)
        feed = {"input_ids": ids, "attention_mask": mask}
        if "token_type_ids" in input_names:
            feed["token_type_ids"] = np.zeros_like(ids)
        feed = {k: v for k, v in feed.items() if k in input_names}
        hidden = session.run(None, feed)[0]  # (B, T, dim) last_hidden_state
        vecs = pool_normalize(hidden, mask)
        if vecs.shape[1] != dim:
            raise SystemExit(f"width {vecs.shape[1]} != expected {dim}")
        return vecs

    return forward


def write_vectors(
    out: str, blobs: Iterable[bytes], shard_sizes: Sequence[int], dim: int = DIM
) -> int:
    """Write the shards' packed float32 vectors to `out`, atomically and only if complete.

    `blobs` must arrive in shard order; each must be exactly shard_sizes[i] * dim * 4 bytes. The
    bytes go to `<out>.partial` and are renamed over `out` after the last shard checks out, so a
    crash, a short shard or a wrong total never leaves a file the loader could mistake for a
    result. Returns the number of vectors written."""
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
        os.replace(partial, out)
    except BaseException:
        if os.path.exists(partial):
            os.remove(partial)
        raise
    return n


# --- Modal ----------------------------------------------------------------------------------------


@app.cls(image=image, gpu="T4", timeout=3600, max_containers=1)
class Embedder:
    @modal.enter()
    def load(self) -> None:
        import nvidia
        from huggingface_hub import hf_hub_download
        from tokenizers import Tokenizer

        # `nvidia` is a NAMESPACE package -- it has no __init__.py, so __file__ is None and
        # os.path.dirname(nvidia.__file__) raises. __path__ is the only way to its roots.
        preload_cuda_libs(list(nvidia.__path__))

        import onnxruntime as ort  # imported AFTER the preload above

        paths = verify_pins(
            lambda rel: hf_hub_download(PINS.model_id, rel, revision=PINS.revision), PINS
        )
        self.tok = Tokenizer.from_file(paths["tokenizer.json"])
        with open(paths["tokenizer_config.json"]) as f:
            tcfg = json.load(f)
        # Truncation mirrors transformers.js's pipeline: the tokenizer's own model_max_length (8192
        # here). Chunks are bounded by indexing.chunkTokens well under that, so truncation is a
        # guard rather than the normal path -- and capping it lower would silently diverge from the
        # query side for any chunk between the two limits.
        self.tok.enable_truncation(max_length=int(tcfg.get("model_max_length", 8192)))
        # NO tokenizer padding: embed() pads each batch itself so it can bucket by length (see
        # pool_normalize for why that is arithmetically identical).
        self.tok.no_padding()
        pad = self.tok.token_to_id("[PAD]")
        self.pad_id = 0 if pad is None else int(pad)

        self.sess = ort.InferenceSession(
            paths["onnx/model.onnx"],
            providers=["CUDAExecutionProvider", "CPUExecutionProvider"],
        )
        require_cuda(self.sess)
        self.input_names = {i.name for i in self.sess.get_inputs()}

    @modal.method()
    def embed(self, texts: list[str]) -> bytes:
        """len(texts) * DIM little-endian float32 in INPUT order (the loader joins positionally)."""
        import numpy as np

        seqs = [e.ids for e in self.tok.encode_batch(texts)]
        forward = make_forward(self.sess, self.input_names, seqs, self.pad_id, DIM)
        vecs = embed_sequences(seqs, forward)
        return np.asarray(vecs, dtype="<f4").tobytes()


@app.local_entrypoint()
def main(texts: str, out: str):
    rows = []
    with open(texts, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line)["text"])
    if not rows:
        raise SystemExit(f"{texts} held no texts")

    shards = [rows[i : i + PER_CALL] for i in range(0, len(rows), PER_CALL)]
    t0 = time.perf_counter()
    # .map preserves input order (order_outputs defaults True) -- load-gpu-vecs.ts joins these
    # positionally against ids.json, so order IS the correctness contract here.
    n = write_vectors(out, Embedder().embed.map(shards), [len(s) for s in shards])
    secs = time.perf_counter() - t0
    print(f"{n} vectors ({DIM}d fp32) -> {out} in {secs:.1f}s ({n / secs:.1f}/s)")
