"""Embed every exported chunk text with nomic-embed-text-v1.5 on one Modal GPU.

Runs THE SAME pinned ONNX graph the bundled local embedder runs: same HF repo, same revision, same
onnx/model.onnx, mean pooling, L2 normalization, and -- like it -- NO task prefix. nomic's model
card asks for "search_document: "/"search_query: " prefixes and embedder-local does not apply them
(packages/embedder-local/src/index.ts); adding them HERE only would make these vectors
non-comparable with the ones the query side produces, which is the one thing that must not happen.

Only the execution provider differs: CUDA here, CPU there. fp32 ONNX on CUDA and on CPU agree to
~1e-6, so what this writes is interchangeable with what `embeddings.provider: "local"` +
`quantized: false` produces at query time. That interchangeability is the whole design -- one
provider.id serves both document and query embedding, so the two sides must be the same function.

    modal run eval/modal_embed_nomic.py --texts texts.jsonl --out vecs.f32

Writes raw little-endian float32, N*768, in the input's line order -- exactly the layout
eval/load-gpu-vecs.ts reads. Pair it with the ids.json eval/export-chunk-texts.ts wrote in the SAME
run; the two files are positionally joined and nothing downstream can detect a mismatch.

Checksums below are model-info.ts's pins. A mismatch means the pin moved on one side only, which is
exactly the silent divergence this verifies away -- a hard failure, not a warning.
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
BATCH = 64
PER_CALL = 256  # texts per remote call, keeps each argument well under Modal's limit

app = modal.App("otc-embed-nomic")
image = modal.Image.debian_slim(python_version="3.11").uv_pip_install(
    "onnxruntime-gpu==1.23.2",
    "tokenizers==0.23.1",
    "huggingface-hub==1.1.2",
    "numpy==2.3.4",
)


@app.cls(image=image, gpu="T4", timeout=3600, max_containers=1)
class Embedder:
    @modal.enter()
    def load(self) -> None:
        import hashlib

        import numpy as np
        import onnxruntime as ort
        from huggingface_hub import hf_hub_download
        from tokenizers import Tokenizer

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
        # Mirror transformers.js's pipeline: padding=True, truncation=True at the tokenizer's own
        # model_max_length. Chunks are bounded by indexing.chunkTokens well under this, so
        # truncation is a guard rather than the normal path.
        self.max_len = int(tcfg.get("model_max_length", 8192))
        self.tok.enable_truncation(max_length=self.max_len)
        self.tok.enable_padding(length=None)

        self.sess = ort.InferenceSession(
            paths["onnx/model.onnx"],
            providers=["CUDAExecutionProvider", "CPUExecutionProvider"],
        )
        if "CUDAExecutionProvider" not in self.sess.get_providers():
            raise SystemExit(
                "CUDA execution provider unavailable -- refusing to embed on CPU here"
            )
        self.input_names = {i.name for i in self.sess.get_inputs()}

    @modal.method()
    def embed(self, texts: list[str]) -> list[list[float]]:
        np = self.np
        out: list[list[float]] = []
        for i in range(0, len(texts), BATCH):
            batch = texts[i : i + BATCH]
            encs = self.tok.encode_batch(batch)
            ids = np.array([e.ids for e in encs], dtype=np.int64)
            mask = np.array([e.attention_mask for e in encs], dtype=np.int64)
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
            vecs = mean / norms
            if vecs.shape[1] != DIM:
                raise SystemExit(f"width {vecs.shape[1]} != expected {DIM}")
            out.extend(vecs.astype(np.float32).tolist())
        return out


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
