// THE-420/THE-504 bench harness: JS fallback vs native cosineBatch (and, for reference, the
// per-pair native call THE-420 already showed is a net loss). Run:
//   node packages/native/bench/cosine-batch.cjs
// (uses the built .node if present; otherwise both "native" and "JS" columns run the same
// pure-JS fallback, so nativeLoaded=false runs still complete but show no native/JS gap.)
//
// THE-504: cosineBatch's query is now a Float32Array (was number[]) — this harness passes one.
const N = require("../index.js"); // umbrella loader: native when built, else JS fallback
const F = require("../fallback.js");

const DIMS = [384, 768, 1024, 1536];
const DOC_COUNTS = [100, 1_000, 10_000];

const rand = (d) => {
  const a = new Float32Array(d);
  for (let i = 0; i < d; i++) a[i] = Math.random() * 2 - 1;
  return a;
};

let SINK = 0;
const time = (fn) => {
  for (let w = 0; w < 10; w++) fn(); // warm
  // Median of repeated timed batches (not mean) — this host shows enough scheduling jitter
  // that a mean over a handful of reps is noise-dominated for the smaller inputs.
  const samples = [];
  const reps = 15;
  for (let r = 0; r < reps; r++) {
    const t0 = performance.now();
    SINK += fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
};

console.log(`nativeLoaded=${N.nativeLoaded} cosineBatch=${typeof N.cosineBatch}`);
console.log("dim,docs,js_fallback_ms,native_batch_ms,speedup_x");

for (const dim of DIMS) {
  for (const rows of DOC_COUNTS) {
    const q = rand(dim);
    const flat = new Float32Array(rows * dim);
    for (let i = 0; i < flat.length; i++) flat[i] = Math.random() * 2 - 1;

    const jsMs = time(() => {
      const o = F.cosineBatch(q, flat, dim);
      let s = 0;
      for (let i = 0; i < o.length; i++) s += o[i];
      return s;
    });
    const nativeMs = time(() => {
      const o = N.cosineBatch(q, flat, dim);
      let s = 0;
      for (let i = 0; i < o.length; i++) s += o[i];
      return s;
    });
    console.log(
      `${dim},${rows},${jsMs.toFixed(3)},${nativeMs.toFixed(3)},${(jsMs / nativeMs).toFixed(2)}`,
    );
  }
}
console.log(`(sink ${SINK.toFixed(2)})`);
