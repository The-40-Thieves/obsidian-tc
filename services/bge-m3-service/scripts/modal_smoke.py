"""On-demand verification of the real ML path against the deps a fresh install pulls.

ci-model-service installs the package --no-deps and mocks the model layer, so torch, FlagEmbedding,
and sentence-transformers are never exercised. This recreates the deployment on Modal (Linux + T4)
with the latest deps and runs the service's own encoder and reranker against the real BAAI models,
the check that caught the sentence-transformers 5.x device="auto" break.

Run:  modal run scripts/modal_smoke.py   (needs a configured modal CLI: pip install modal)
"""

from __future__ import annotations

from pathlib import Path

import modal  # type: ignore[import-not-found]

SERVICE_PKG = Path(__file__).resolve().parent.parent / "obsidian_tc_bge"

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "torch",
        "numpy",
        "huggingface-hub",
        "FlagEmbedding",
        "sentence-transformers",
        "fastapi",
        "pydantic",
        "uvicorn[standard]",
    )
    .add_local_dir(str(SERVICE_PKG), remote_path="/root/obsidian_tc_bge")
)
app = modal.App("bge-m3-verify", image=image)


@app.function(gpu="T4", timeout=1800)
def smoke() -> str:
    import importlib.metadata as im
    import sys

    def check(cond: bool, msg: str) -> None:
        if not cond:
            raise RuntimeError(msg)

    pkgs = [
        "torch",
        "numpy",
        "huggingface-hub",
        "FlagEmbedding",
        "sentence-transformers",
        "fastapi",
        "pydantic",
    ]
    print("=== resolved dep versions (fresh-install latest) ===")
    for p in pkgs:
        try:
            print(f"  {p} == {im.version(p)}")
        except im.PackageNotFoundError:
            print(f"  {p}: not installed")

    sys.path.insert(0, "/root")
    from obsidian_tc_bge.model import BgeM3Encoder  # type: ignore[import-not-found]
    from obsidian_tc_bge.reranker import BgeReranker  # type: ignore[import-not-found]

    print("=== encoder: BgeM3Encoder(BAAI/bge-m3) ===")
    enc = BgeM3Encoder("BAAI/bge-m3", "main", "auto", True, 512)
    texts = ["the quick brown fox jumps over the lazy dog"]
    item = enc.encode(texts, ["dense", "sparse", "colbert"])[0]
    dim = len(item.dense) if item.dense else 0
    check(dim == 1024, f"dense dim={dim}")
    check(bool(item.sparse and item.sparse.token_ids and item.sparse.weights), "sparse empty")
    check(bool(item.colbert and item.colbert.vectors), "colbert empty")
    print(
        f"  ENCODE OK device={enc.device} dense={dim} "
        f"sparse={len(item.sparse.token_ids)} colbert={len(item.colbert.vectors)}"
    )

    print("=== reranker: BgeReranker(BAAI/bge-reranker-v2-m3) ===")
    rr = BgeReranker("BAAI/bge-reranker-v2-m3", "main", "auto", 512)
    docs = [
        "a fox is a small wild member of the dog family",
        "bananas are a yellow tropical fruit",
    ]
    ranked = rr.rerank("what is a fox?", docs)
    check(all(0.0 <= s <= 1.0 for _, s in ranked), f"scores out of [0,1]: {ranked}")
    check(ranked[0][0] == 0, f"expected the fox doc (idx 0) first, got {ranked}")
    print(f"  RERANK OK {[(i, round(s, 4)) for i, s in ranked]}")
    return "ALL SMOKE CHECKS PASSED"


@app.local_entrypoint()
def main() -> None:
    print(smoke.remote())  # type: ignore[attr-defined]
