// THE-504 Criterion benches: measures the cosine_batch optimization (precomputed query norm +
// single-pass dot/norm per doc) against the OLD "reuse cosine_core per doc" it replaced, across
// the requested dims x docs matrix.
//
// The crate is a napi-rs `cdylib` only (no `rlib`), so a separate `benches/` binary cannot link
// against `src/lib.rs` via `extern crate` without adding `rlib` to `crate-type` and making the
// internal helpers `pub` — a public-API change out of scope for a benchmarking harness. Instead,
// the algorithms are reproduced verbatim here: `cosine_batch_core_new` is copy-pasted from the
// current `src/lib.rs::cosine_batch_core` (kept in lockstep manually — re-copy if that function
// changes), and `cosine_batch_core_old` reconstructs the pre-THE-504 body this ticket replaced
// (reuse `cosine_core` per doc). `cosine_batch_matches_per_pair` and
// `cosine_batch_refactor_matches_naive_per_doc_when_query_is_exact_f32` in src/lib.rs's own test
// module are the source of truth that the SHIPPED code is correct; this file exists only to time
// it, not to re-verify correctness.
//
// Run: `cargo bench` from packages/native (writes HTML reports to target/criterion/).
// The JS-fallback-vs-Rust-batch leg of the requested comparison lives in
// `bench/cosine-batch.cjs` (a Rust Criterion harness cannot invoke the JS fallback without
// embedding a JS engine); run it with `node bench/cosine-batch.cjs` and see the ticket report for
// combined numbers.

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};
use std::hint::black_box;

/// Pure f64 cosine core over a query slice (f64) and a document slice (f32, widened in-loop).
/// Verbatim copy of `cosine_core` in src/lib.rs.
fn cosine_core(a: &[f64], b: &[f32]) -> f64 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0_f64;
    let mut norm_a = 0.0_f64;
    let mut norm_b = 0.0_f64;
    for i in 0..a.len() {
        let bi = b[i] as f64;
        dot += a[i] * bi;
        norm_a += a[i] * a[i];
        norm_b += bi * bi;
    }
    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }
    dot / (norm_a.sqrt() * norm_b.sqrt())
}

/// OLD `cosine_batch_core`, pre-THE-504: reuses `cosine_core` per doc, recomputing the query's
/// norm on every document.
#[allow(clippy::manual_is_multiple_of)] // deliberately reproduces the pre-fix code (item 7)
fn cosine_batch_core_old(query: &[f64], docs_flat: &[f32], dim: usize) -> Vec<f64> {
    if dim == 0 || query.len() != dim || docs_flat.len() % dim != 0 {
        return Vec::new();
    }
    docs_flat
        .chunks_exact(dim)
        .map(|doc| cosine_core(query, doc))
        .collect()
}

/// NEW `cosine_batch_core`, post-THE-504: query norm precomputed once; each doc's dot product and
/// norm computed together in a single pass. Query is `&[f32]` (matches the real signature — the
/// napi `Float32Array` param), widened to f64 for accumulation exactly as src/lib.rs does.
fn cosine_batch_core_new(query: &[f32], docs_flat: &[f32], dim: usize) -> Vec<f64> {
    if dim == 0 || query.len() != dim || !docs_flat.len().is_multiple_of(dim) {
        return Vec::new();
    }
    let mut norm_q = 0.0_f64;
    for &q in query {
        let qf = q as f64;
        norm_q += qf * qf;
    }
    if norm_q == 0.0 {
        return vec![0.0; docs_flat.len() / dim];
    }
    let norm_q_sqrt = norm_q.sqrt();
    docs_flat
        .chunks_exact(dim)
        .map(|doc| {
            let mut dot = 0.0_f64;
            let mut norm_d = 0.0_f64;
            for i in 0..dim {
                let qi = query[i] as f64;
                let di = doc[i] as f64;
                dot += qi * di;
                norm_d += di * di;
            }
            if norm_d == 0.0 {
                0.0
            } else {
                dot / (norm_q_sqrt * norm_d.sqrt())
            }
        })
        .collect()
}

/// f32-accumulator variant of the NEW core, for the item-4 f32-vs-f64-accumulation bench.
/// NOT used in production — src/lib.rs keeps f64 accumulation (see the ticket report).
fn cosine_batch_core_new_f32_accum(query: &[f32], docs_flat: &[f32], dim: usize) -> Vec<f32> {
    if dim == 0 || query.len() != dim || !docs_flat.len().is_multiple_of(dim) {
        return Vec::new();
    }
    let mut norm_q = 0.0_f32;
    for &q in query {
        norm_q += q * q;
    }
    if norm_q == 0.0 {
        return vec![0.0; docs_flat.len() / dim];
    }
    let norm_q_sqrt = norm_q.sqrt();
    docs_flat
        .chunks_exact(dim)
        .map(|doc| {
            let mut dot = 0.0_f32;
            let mut norm_d = 0.0_f32;
            for i in 0..dim {
                dot += query[i] * doc[i];
                norm_d += doc[i] * doc[i];
            }
            if norm_d == 0.0 {
                0.0
            } else {
                dot / (norm_q_sqrt * norm_d.sqrt())
            }
        })
        .collect()
}

fn make_inputs(dim: usize, n_docs: usize) -> (Vec<f32>, Vec<f64>, Vec<f32>) {
    // Deterministic pseudo-random fill (xorshift) so runs are reproducible without a rand dep.
    let mut state: u64 = 0x9E3779B97F4A7C15 ^ ((dim as u64) << 32) ^ n_docs as u64;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        ((state >> 11) as f64 / (1u64 << 53) as f64) * 2.0 - 1.0
    };
    let query_f32: Vec<f32> = (0..dim).map(|_| next() as f32).collect();
    let query_f64: Vec<f64> = query_f32.iter().map(|&q| q as f64).collect();
    let docs_flat: Vec<f32> = (0..dim * n_docs).map(|_| next() as f32).collect();
    (query_f32, query_f64, docs_flat)
}

fn bench_precompute_norm(c: &mut Criterion) {
    let mut group = c.benchmark_group("cosine_batch_old_vs_new");
    for &dim in &[384usize, 768, 1024, 1536] {
        for &n_docs in &[100usize, 1_000, 10_000] {
            let (query_f32, query_f64, docs_flat) = make_inputs(dim, n_docs);
            let id = format!("dim={dim}/docs={n_docs}");
            group.bench_with_input(BenchmarkId::new("old_per_doc_norm", &id), &id, |b, _| {
                b.iter(|| {
                    black_box(cosine_batch_core_old(
                        black_box(&query_f64),
                        black_box(&docs_flat),
                        dim,
                    ))
                });
            });
            group.bench_with_input(BenchmarkId::new("new_precomputed_norm", &id), &id, |b, _| {
                b.iter(|| {
                    black_box(cosine_batch_core_new(
                        black_box(&query_f32),
                        black_box(&docs_flat),
                        dim,
                    ))
                });
            });
        }
    }
    group.finish();
}

fn bench_f32_vs_f64_accumulation(c: &mut Criterion) {
    // Item 4: benchmark f32 vs f64 accumulation BEFORE changing numeric behaviour. Run at the
    // largest matrix point (dim=1536, 10k docs) where an accumulator-width difference would show
    // up most, if it shows up at all.
    let mut group = c.benchmark_group("cosine_batch_accumulator_width");
    let (query_f32, _query_f64, docs_flat) = make_inputs(1536, 10_000);
    group.bench_function("f64_accumulation (shipped)", |b| {
        b.iter(|| {
            black_box(cosine_batch_core_new(
                black_box(&query_f32),
                black_box(&docs_flat),
                1536,
            ))
        });
    });
    group.bench_function("f32_accumulation (not shipped)", |b| {
        b.iter(|| {
            black_box(cosine_batch_core_new_f32_accum(
                black_box(&query_f32),
                black_box(&docs_flat),
                1536,
            ))
        });
    });
    group.finish();
}

criterion_group!(benches, bench_precompute_norm, bench_f32_vs_f64_accumulation);
criterion_main!(benches);
