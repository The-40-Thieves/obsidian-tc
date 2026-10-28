// Retrieval kernels. The js* functions are the pure-JS implementations the server uses whenever the
// native addon is not loaded (and the reference the Rust kernels mirror); they are imported
// directly so the measurement never depends on whether a prebuilt addon happens to be present.
import { test } from "vitest";
import { queryTerms } from "../src/search/chunk_fts";
import { kmeans } from "../src/search/cluster";
import { jsBm25Score, jsCosineBatch, jsRougeLLcs, jsTokenize } from "../src/search/native";
import { makeFloat32, makeText, makeTokenIds, makeVector, rng } from "./fixtures";

test("jsCosineBatch", async ({ bench }) => {
  for (const [dim, docs] of [
    [384, 1_000],
    [1024, 1_000],
  ] as const) {
    const query = makeFloat32(dim, dim);
    const flat = makeFloat32(dim * docs, dim + docs);
    await bench(`dim=${dim} docs=${docs}`, () => {
      jsCosineBatch(query, flat, dim);
    }).run();
  }
});

test("lexical", async ({ bench }) => {
  const shortText = makeText(64, 1);
  const longText = makeText(4_096, 2);

  await bench("jsTokenize (64 words)", () => {
    jsTokenize(shortText);
  }).run();
  await bench("jsTokenize (4k words)", () => {
    jsTokenize(longText);
  }).run();
  await bench("queryTerms", () => {
    queryTerms("How does the hybrid retrieval pipeline rank backlinks for the weekly review?");
  }).run();

  // Per document: its length and one (term frequency, document frequency) pair per query term.
  const r = rng(7);
  const dfs = [3, 25, 120, 400, 800, 999];
  const docs = Array.from({ length: 1_000 }, () => ({
    len: 50 + Math.floor(r() * 900),
    terms: dfs.map((df) => ({ tf: Math.floor(r() * 6), df })),
  }));
  const bm25 = jsBm25Score;
  await bench("jsBm25Score (6 terms x 1k docs)", () => {
    let total = 0;
    for (const d of docs) {
      for (const { tf, df } of d.terms) total += bm25(tf, d.len, 350, df, 1_000);
    }
    return total;
  }).run();
});

test("jsRougeLLcs", async ({ bench }) => {
  for (const [la, lb] of [
    [32, 32],
    [256, 256],
  ] as const) {
    const a = makeTokenIds(la, 500, 1);
    const b = makeTokenIds(lb, 500, 2);
    await bench(`${la}x${lb}`, () => {
      jsRougeLLcs(a, b);
    }).run();
  }
});

test("kmeans", async ({ bench }) => {
  const r = rng(11);
  const vectors = Array.from({ length: 300 }, () => makeVector(64, r));
  await bench("300 vectors, dim=64, k=8", () => {
    kmeans(vectors, 8, { seed: 1 });
  }).run();
});
