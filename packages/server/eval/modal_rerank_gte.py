"""Score a rerank-arms pool file with gte-reranker-modernbert-base on one Modal GPU.

The reranker-arms stage `rerank` runs a model on this box's CPU. gte-reranker-modernbert-base
(149M parameters, 22 layers) measured about 80 s per 30-passage search there under load, so the
multi-shape suite scores it on a rented T4 instead and writes the SAME result file `rerank` writes,
which `rerank-arms.ts score` then reads like any other arm. Public corpora only: the pool text
leaves the machine.

    modal run eval/modal_rerank_gte.py --pools pools.json --out r.json [--k 30] [--title-prefix]

The passage is the shipped one (`formatRerankPassage` in src/search/rerank.ts): the chunk, or with
`--title-prefix` the note's file name without `.md`, a blank line, then the chunk. Pairs are
(query, passage), 512 tokens, fp16, raw logits (only their order is read). Latency is the GPU
forward time per query and is NOT comparable to the CPU arms'.
"""

import json
import time

import modal

MODEL = "Alibaba-NLP/gte-reranker-modernbert-base"
REVISION = "f7481e6055501a30fb19d090657df9ec1f79ab2c"
ARM = "gte-reranker-modernbert-base-gpu"
BATCH = 16
PER_CALL = 20  # queries per remote call, keeps each argument small

app = modal.App("otc-eval-gte-rerank")
image = modal.Image.debian_slim(python_version="3.14").uv_pip_install(
    "torch==2.14.1", "transformers==5.19.0"
)


def note_title(path: str) -> str:
    name = path.rsplit("/", 1)[-1]
    return name[:-3] if name.lower().endswith(".md") else name


@app.cls(image=image, gpu="T4", timeout=3600, max_containers=1)
class Scorer:
    @modal.enter()
    def load(self) -> None:
        import torch
        from transformers import AutoModelForSequenceClassification, AutoTokenizer

        self.tok = AutoTokenizer.from_pretrained(MODEL, revision=REVISION)
        self.model = AutoModelForSequenceClassification.from_pretrained(
            MODEL, revision=REVISION, dtype=torch.float16
        ).to("cuda")
        self.model.eval()

    @modal.method()
    def score(self, items: list[dict], title_prefix: bool) -> list[dict]:
        import torch

        out = []
        for it in items:
            passages = [
                f"{note_title(c['path'])}\n\n{c['text']}" if title_prefix else c["text"]
                for c in it["candidates"]
            ]
            torch.cuda.synchronize()
            t0 = time.perf_counter()
            logits: list[float] = []
            with torch.no_grad():
                for i in range(0, len(passages), BATCH):
                    chunk = passages[i : i + BATCH]
                    enc = self.tok(
                        [it["query"]] * len(chunk),
                        chunk,
                        padding=True,
                        truncation=True,
                        max_length=512,
                        return_tensors="pt",
                    ).to("cuda")
                    logits.extend(self.model(**enc).logits.view(-1).float().tolist())
            torch.cuda.synchronize()
            ms = (time.perf_counter() - t0) * 1000
            out.append(
                {
                    "id": it["id"],
                    "hits": [{"index": i, "score": s} for i, s in enumerate(logits)],
                    "latency_ms": round(ms),
                    "chars_sent": sum(len(p) for p in passages) + len(it["query"]) * len(passages),
                    "outcome": "executed",
                }
            )
        return out


@app.local_entrypoint()
def main(pools: str, out: str, k: int = 30, title_prefix: bool = False):
    with open(pools) as f:
        pf = json.load(f)
    if pf.get("kind") != "public":
        raise SystemExit("refusing a non-public pool: its text would leave the machine")
    items = [
        {"id": p["id"], "query": p["query_text"], "candidates": p["candidates"][:k]}
        for p in pf["pools"]
    ]
    batches = [items[i : i + PER_CALL] for i in range(0, len(items), PER_CALL)]
    per_query = {}
    for res in Scorer().score.map(batches, kwargs={"title_prefix": title_prefix}):
        for r in res:
            per_query[r["id"]] = {k2: v for k2, v in r.items() if k2 != "id"}
    result = {"arm": ARM, "k": k, "kind": pf["kind"], "perQuery": per_query}
    if title_prefix:
        result["title_prefix"] = True
    with open(out, "w") as f:
        json.dump(result, f)
    lat = sorted(v["latency_ms"] for v in per_query.values())
    print(f"{ARM} k={k}: {len(per_query)}/{len(items)} executed, p50 {lat[len(lat) // 2]} ms")
