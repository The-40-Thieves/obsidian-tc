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
run; the two files are positionally joined and nothing downstream can detect a mismatch. Check the
output is exactly N*768*4 bytes before loading: a crash mid-run leaves a SHORT file, and the
completeness assertion in the entrypoint cannot fire because the exception preempts it.

Checksums below are model-info.ts's pins. A mismatch means the pin moved on one side only, which is
exactly the silent divergence this verifies away -- a hard failure, not a warning.

WHY THE NVIDIA PIP WHEELS AND THE ctypes PRELOAD: unlike eval/modal_rerank_gte.py, this image has
no torch, and torch is what silently supplies CUDA 12 / cuDNN 9 to a debian_slim image. Without
them onnxruntime-gpu cannot dlopen libonnxruntime_providers_cuda.so ("libcublasLt.so.12: cannot
open shared object file") and falls back to CPU -- which for a GPU batch job is a 100x slowdown
that still produces correct-looking output. Preloading RTLD_GLOBAL from nvidia.__path__ satisfies
the provider's link-time deps without guessing a site-packages path or an image registry tag, and
the CUDA assertion below turns a silent CPU fallback into a hard failure.
"""

import json
import struct
import time

import modal

MODEL_ID = "nomic-ai/nomic-embed-text-v1.5"
REVISION = "e9b6763023c676ca8431644204f50c2b100d9aab"
DIM = 768
# packages/embedder-local/src/model-info.ts NOMIC_EMBED_TEXT_V1_5 -- fp32 variant + shared files.
PINS = {
    "onnx/model.onnx": "147d5aa88c2101237358e17796cf3a227cead1ec304ec34b465bb08e9d952965",
    "tokenizer.json": "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",
    "tokenizer_config.json": "d7e0000bcc80134debd2222220427e6bf5fa20a669f40a0d0d1409cc18e0a9bc",
    "config.json": "9ab00bd92cee80a569f708140b7b6c1661a65891ff3765b1519e181ba2f2c92b",
}
READ_BLOCK = 1048576
MAX_BATCH = 32
# Bound on batch_size * seq_len^2, the term attention memory scales with. Twice measured on a 16 GB
# T4: a fixed batch of 64 asked for one 5.6 GB buffer, and a 3e7 budget still asked for 1.31 GB and
# died. 1.31e9/(12 heads * 4 B) back-solves to B*T^2 ~= 27e6, i.e. the budget WAS the binding
# constraint -- ORT keeps several tensors that size live at once, so the budget has to leave room
# for more than one. 8e6 puts the largest single buffer near 384 MB. chunks.token_count is only an
# ESTIMATE (max 524 in this vault); real tokenization of code and URLs runs well above it, which is
# why this is a budget and not a fixed batch, and why _forward_split exists underneath it.
ATTN_BUDGET = 8_000_000
PER_CALL = 256  # texts per remote call, keeps each argument well under Modal's limit
# RTLD_GLOBAL preload target, relative to each `nvidia` namespace root. Deliberately EVERY shared
# object rather than a named list: naming them one at a time is whack-a-mole, because the CUDA
# provider's unmet dependency is only reported one library per run (cublasLt, then curand, then...).
CUDA_LIB_GLOB = "*/lib/*.so*"
PRELOAD_PASSES = (
    3  # RTLD_GLOBAL in glob order can need a retry when one lib depends on another
)
OOM_MARKERS = (
    "failed to allocate memory",
    "out of memory",
    "cudaerrormemoryallocation",
)

app = modal.App("otc-embed-nomic")
image = modal.Image.debian_slim(python_version="3.11").uv_pip_install(
    "onnxruntime-gpu==1.23.2",
    # The full CUDA 12 runtime set the ORT CUDA provider links against. torch would supply these
    # implicitly (as eval/modal_rerank_gte.py gets for free) at the cost of a ~2.5 GB image.
    "nvidia-cuda-runtime-cu12",
    "nvidia-cuda-nvrtc-cu12",
    "nvidia-cublas-cu12",
    "nvidia-cudnn-cu12",
    "nvidia-curand-cu12",
    "nvidia-cufft-cu12",
    "nvidia-cusparse-cu12",
    "nvidia-cusolver-cu12",
    "nvidia-nvjitlink-cu12",
    "tokenizers==0.23.1",
    "huggingface-hub==1.1.2",
    "numpy==2.3.4",
)


@app.cls(image=image, gpu="T4", timeout=3600, max_containers=1)
class Embedder:
    @modal.enter()
    def load(self) -> None:
        import ctypes
        import glob
        import hashlib
        import os

        import nvidia
        import numpy as np
        from huggingface_hub import hf_hub_download
        from tokenizers import Tokenizer

        # `nvidia` is a NAMESPACE package -- it has no __init__.py, so __file__ is None and
        # os.path.dirname(nvidia.__file__) raises. __path__ is the only way to its roots.
        candidates: list[str] = []
        for root in list(nvidia.__path__):
            candidates.extend(sorted(glob.glob(os.path.join(root, CUDA_LIB_GLOB))))
        pending = list(candidates)
        loaded = 0
        for _ in range(PRELOAD_PASSES):
            retry: list[str] = []
            for so in pending:
                try:
                    ctypes.CDLL(so, mode=ctypes.RTLD_GLOBAL)
                    loaded += 1
                except OSError:
                    retry.append(
                        so
                    )  # may load once a dependency of its own is in the namespace
            pending = retry
            if not pending:
                break
        if loaded == 0:
            raise SystemExit(
                f"preloaded no CUDA libraries from {len(candidates)} candidate(s) under "
                "nvidia.__path__ -- the CUDA provider cannot dlopen without them; check the "
                "nvidia-*-cu12 wheels are present in the image"
            )

        import onnxruntime as ort  # imported AFTER the preload above

        self.np = np
        paths = {}
        for rel, want in PINS.items():
            p = hf_hub_download(MODEL_ID, rel, revision=REVISION)
            h = hashlib.sha256()
            with open(p, "rb") as f:
                for block in iter(lambda: f.read(READ_BLOCK), b""):
                    h.update(block)
            got = h.hexdigest()
            if got != want:
                raise SystemExit(
                    f"checksum mismatch for {rel}: expected {want}, got {got}. "
                    "model-info.ts's pin and this file's pin disagree -- do not ship these vectors."
                )
            paths[rel] = p

        self.tok = Tokenizer.from_file(paths["tokenizer.json"])
        with open(paths["tokenizer_config.json"]) as f:
            tcfg = json.load(f)
        # Truncation mirrors transformers.js's pipeline: the tokenizer's own model_max_length (8192
        # here). Chunks are bounded by indexing.chunkTokens well under that, so truncation is a
        # guard rather than the normal path -- and capping it lower would silently diverge from the
        # query side for any chunk between the two limits.
        self.max_len = int(tcfg.get("model_max_length", 8192))
        self.tok.enable_truncation(max_length=self.max_len)
        # NO tokenizer padding: embed() pads each batch itself so it can bucket by length. Mean
        # pooling is mask-weighted, so manual padding is arithmetically identical to the
        # tokenizer's -- verified, the bucketed path reproduced the tokenizer-padded vectors to the
        # same 2.9e-07 against local CPU fp32.
        self.tok.no_padding()
        pad = self.tok.token_to_id("[PAD]")
        self.pad_id = 0 if pad is None else int(pad)

        self.sess = ort.InferenceSession(
            paths["onnx/model.onnx"],
            providers=["CUDAExecutionProvider", "CPUExecutionProvider"],
        )
        if "CUDAExecutionProvider" not in self.sess.get_providers():
            raise SystemExit(
                "CUDA execution provider unavailable -- refusing to embed on CPU here"
            )
        self.input_names = {i.name for i in self.sess.get_inputs()}

    def _forward(self, seqs: list[list[int]], idx: list[int]):
        """One padded forward pass over the given indices. Returns (len(idx), DIM) float32."""
        np = self.np
        width = max(len(seqs[i]) for i in idx)
        ids = np.full((len(idx), width), self.pad_id, dtype=np.int64)
        mask = np.zeros((len(idx), width), dtype=np.int64)
        for row, i in enumerate(idx):
            s = seqs[i]
            ids[row, : len(s)] = s
            mask[row, : len(s)] = 1

        feed = {"input_ids": ids, "attention_mask": mask}
        if "token_type_ids" in self.input_names:
            feed["token_type_ids"] = np.zeros_like(ids)
        feed = {k: v for k, v in feed.items() if k in self.input_names}
        hidden = self.sess.run(None, feed)[0]  # (B, T, DIM) last_hidden_state

        # Mean pooling over non-padding tokens, then L2 normalize -- transformers.js
        # `{ pooling: "mean", normalize: true }`, which is what embedder-local passes.
        m = mask.astype(np.float32)[..., None]
        summed = (hidden.astype(np.float32) * m).sum(axis=1)
        counts = np.maximum(m.sum(axis=1), 1e-9)
        mean = summed / counts
        norms = np.maximum(np.linalg.norm(mean, axis=1, keepdims=True), 1e-12)
        vecs = (mean / norms).astype(np.float32)
        if vecs.shape[1] != DIM:
            raise SystemExit(f"width {vecs.shape[1]} != expected {DIM}")
        return vecs

    def _forward_split(self, seqs, idx: list[int], out: list) -> None:
        """_forward, halving the batch on an allocation failure. A budget alone is a guess about
        how much ORT keeps live at once; this makes a wrong guess cost throughput instead of the
        whole run. Only allocation failures split -- anything else raises immediately rather than
        being retried one row at a time behind a misleading OOM story."""
        try:
            vecs = self._forward(seqs, idx)
        except (
            Exception
        ) as e:  # noqa: BLE001 - re-raised below unless it is an allocation failure
            msg = str(e).lower()
            if not any(k in msg for k in OOM_MARKERS) or len(idx) == 1:
                raise
            mid = len(idx) // 2
            self._forward_split(seqs, idx[:mid], out)
            self._forward_split(seqs, idx[mid:], out)
            return
        for row, i in enumerate(idx):
            out[i] = vecs[row].tolist()

    @modal.method()
    def embed(self, texts: list[str]) -> list[list[float]]:
        seqs = [e.ids for e in self.tok.encode_batch(texts)]
        # Length-sorted so each batch's padding width is set by a near neighbour, not by the one
        # longest chunk in an arbitrary fixed-width window.
        order = sorted(range(len(seqs)), key=lambda i: len(seqs[i]))
        out: list[list[float] | None] = [None] * len(texts)

        pos = 0
        while pos < len(order):
            take = 1
            t_max = len(seqs[order[pos]])
            while take < MAX_BATCH and pos + take < len(order):
                cand = max(t_max, len(seqs[order[pos + take]]))
                if cand * cand * (take + 1) > ATTN_BUDGET:
                    break
                t_max = cand
                take += 1
            self._forward_split(seqs, order[pos : pos + take], out)
            pos += take

        missing = sum(1 for v in out if v is None)
        if missing:
            raise SystemExit(f"internal: {missing} text(s) produced no vector")
        # Restored to INPUT order: load-gpu-vecs.ts joins these positionally against ids.json.
        return [v for v in out if v is not None]


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
    n = 0
    # .map preserves input order (order_outputs defaults True) -- load-gpu-vecs.ts joins these
    # positionally against ids.json, so order IS the correctness contract here.
    with open(out, "wb") as fh:
        for vecs in Embedder().embed.map(shards):
            for v in vecs:
                fh.write(struct.pack("<%df" % DIM, *v))
                n += 1
    secs = time.perf_counter() - t0
    if n != len(rows):
        raise SystemExit(
            f"wrote {n} vectors for {len(rows)} texts -- refusing a partial file"
        )
    print(f"{n} vectors ({DIM}d fp32) -> {out} in {secs:.1f}s ({n / secs:.1f}/s)")
