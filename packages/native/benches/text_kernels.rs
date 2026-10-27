// Benches for the native lexical / ROUGE-L kernels that sit next to `cosine_batch` on the
// retrieval path: `tokenize` (index- and query-time BM25 tokenization), `bm25_score` (summed per
// query term per candidate) and `rouge_l_lcs_core` (the two-row LCS DP behind ROUGE-L).
//
// Like `cosine_batch.rs`, this links the SHIPPED functions from the rlib rather than copies.
// Inputs are generated deterministically (xorshift) so every run measures the same work.
//
// Run: `cargo bench --bench text_kernels` from packages/native, or under CodSpeed with
// `cargo codspeed build && cargo codspeed run`.

use criterion::{BenchmarkId, Criterion, criterion_group, criterion_main};
use std::hint::black_box;

use obsidian_tc_native::{bm25_score, rouge_l_lcs_core, tokenize};

struct XorShift(u64);

impl XorShift {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
}

const WORDS: &[&str] = &[
    "Obsidian",
    "vault",
    "note",
    "Markdown",
    "retrieval",
    "hybrid",
    "embedding",
    "frontmatter",
    "backlink",
    "tag",
    "daily",
    "périodique",
    "memory",
    "HITL",
    "confirmation",
    "graph",
    "chunk",
    "index",
    "2026-10-27",
    "naïve",
];

/// A Markdown-ish note of roughly `n_words` words with headings, links and punctuation, so the
/// tokenizer's split-on-non-alphanumeric path sees realistic separators.
fn make_note(n_words: usize, seed: u64) -> String {
    let mut rng = XorShift(0x9E3779B97F4A7C15 ^ seed);
    let mut out = String::with_capacity(n_words * 9);
    for i in 0..n_words {
        if i % 40 == 0 {
            out.push_str("\n## ");
        }
        let w = WORDS[(rng.next() % WORDS.len() as u64) as usize];
        match rng.next() % 10 {
            0 => {
                out.push_str("[[");
                out.push_str(w);
                out.push_str("]] ");
            }
            1 => {
                out.push('#');
                out.push_str(w);
                out.push_str(", ");
            }
            2 => {
                out.push_str(w);
                out.push_str(". ");
            }
            _ => {
                out.push_str(w);
                out.push(' ');
            }
        }
    }
    out
}

fn make_token_ids(len: usize, vocab: u64, seed: u64) -> Vec<i32> {
    let mut rng = XorShift(0xD1B54A32D192ED03 ^ seed);
    (0..len).map(|_| (rng.next() % vocab) as i32).collect()
}

fn bench_tokenize(c: &mut Criterion) {
    let mut group = c.benchmark_group("tokenize");
    for &n_words in &[64usize, 1_024, 16_384] {
        let note = make_note(n_words, n_words as u64);
        group.bench_with_input(BenchmarkId::from_parameter(n_words), &note, |b, note| {
            b.iter(|| black_box(tokenize(black_box(note.clone()))));
        });
    }
    group.finish();
}

fn bench_bm25(c: &mut Criterion) {
    // Score every candidate of a 1k-document corpus for a 6-term query, the way the lexical leg
    // of hybrid retrieval sums per-term contributions.
    let mut rng = XorShift(0xA0761D6478BD642F);
    let doc_count = 1_000.0;
    let avg_doc_len = 350.0;
    let docs: Vec<(f64, [f64; 6])> = (0..1_000)
        .map(|_| {
            let len = 50.0 + (rng.next() % 900) as f64;
            let mut tfs = [0.0; 6];
            for tf in &mut tfs {
                *tf = (rng.next() % 6) as f64;
            }
            (len, tfs)
        })
        .collect();
    let dfs = [3.0, 25.0, 120.0, 400.0, 800.0, 999.0];

    c.bench_function("bm25_score/query6_docs1000", |b| {
        b.iter(|| {
            let mut total = 0.0;
            for (len, tfs) in black_box(&docs) {
                for (tf, df) in tfs.iter().zip(dfs.iter()) {
                    total += bm25_score(*tf, *len, avg_doc_len, *df, doc_count);
                }
            }
            black_box(total)
        });
    });
}

fn bench_rouge_l_lcs(c: &mut Criterion) {
    let mut group = c.benchmark_group("rouge_l_lcs");
    for &(len_a, len_b) in &[(32usize, 32usize), (256, 256), (1_024, 512)] {
        let a = make_token_ids(len_a, 500, 1);
        let b_ids = make_token_ids(len_b, 500, 2);
        let id = format!("{len_a}x{len_b}");
        group.bench_with_input(BenchmarkId::from_parameter(id), &(), |b, _| {
            b.iter(|| black_box(rouge_l_lcs_core(black_box(&a), black_box(&b_ids))));
        });
    }
    group.finish();
}

criterion_group!(benches, bench_tokenize, bench_bm25, bench_rouge_l_lcs);
criterion_main!(benches);
