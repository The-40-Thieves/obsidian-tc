// First bench harness (THE-420): proves the BATCHED native cosine beats JS on the brute-force
// recall pattern, whereas the per-pair native call is ~13-22x SLOWER (N-API query re-marshaling
// per call). Run: `node packages/native/bench/cosine-batch.cjs` (uses the built .node if present).
const N = require("../index.js"); // umbrella loader: native when built, else JS fallback
const F = require("../fallback.js");

const DIM = 768;
const ROWS = 20000;
const rand = (d) => {
  const a = new Array(d);
  for (let i = 0; i < d; i++) a[i] = Math.random() * 2 - 1;
  return a;
};
const q = rand(DIM);
const flat = new Float32Array(ROWS * DIM);
for (let i = 0; i < flat.length; i++) flat[i] = Math.random() * 2 - 1;
const docs = [];
for (let i = 0; i < ROWS; i++) docs.push(flat.subarray(i * DIM, i * DIM + DIM));

let SINK = 0;
const time = (fn) => {
  for (let w = 0; w < 3; w++) fn(); // warm
  const t0 = performance.now();
  SINK += fn();
  return performance.now() - t0;
};

const perCallNative = time(() => {
  let s = 0;
  for (let i = 0; i < ROWS; i++) s += N.cosineSimilarity(q, docs[i]);
  return s;
});
const perCallJs = time(() => {
  let s = 0;
  for (let i = 0; i < ROWS; i++) s += F.cosineSimilarity(q, docs[i]);
  return s;
});
const batchedNative = time(() => {
  const o = N.cosineBatch(q, flat, DIM);
  let s = 0;
  for (let i = 0; i < o.length; i++) s += o[i];
  return s;
});

console.log(
  `nativeLoaded=${N.nativeLoaded} cosineBatch=${typeof N.cosineBatch} ROWS=${ROWS} DIM=${DIM}`,
);
console.log(`per-call native : ${perCallNative.toFixed(1)} ms`);
console.log(`per-call JS     : ${perCallJs.toFixed(1)} ms`);
console.log(`batched native  : ${batchedNative.toFixed(1)} ms`);
console.log(`=> batched vs per-call-native: ${(perCallNative / batchedNative).toFixed(1)}x faster`);
console.log(`=> batched vs per-call-JS    : ${(perCallJs / batchedNative).toFixed(2)}x`);
console.log(`(sink ${SINK.toFixed(2)})`);
