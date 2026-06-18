#![deny(clippy::all)]

//! Native perf primitives for obsidian-tc. M0 shipped `cosine_similarity` to
//! verify the napi-rs pipeline. M2 (G4.M2 / THE-178) adds the lexical-search
//! primitives the spec assigns to the native module (G2.2 component 9): a
//! tokenizer and a BM25 term-scoring function. RRF and the sqlite-vec wrapper
//! (also listed in G2.2 component 9) are deferred — RRF is a V2 hybrid-fusion
//! input not used by M2 search, and sqlite-vec is loaded as a SQLite extension
//! at the TS/db layer rather than wrapped here. Every export has a pure-JS
//! fallback on the TypeScript side, so the server runs without this module.

use napi_derive::napi;

/// Cosine similarity between two equal-length vectors. Used by the semantic
/// brute-force recall path when the sqlite-vec extension is unavailable.
/// Inputs are plain JS number arrays (f64); the zero-copy `Float32Array` path
/// is a later optimization.
#[napi]
pub fn cosine_similarity(a: Vec<f64>, b: Vec<f64>) -> f64 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0_f64;
    let mut norm_a = 0.0_f64;
    let mut norm_b = 0.0_f64;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        norm_a += a[i] * a[i];
        norm_b += b[i] * b[i];
    }
    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }
    dot / (norm_a.sqrt() * norm_b.sqrt())
}

/// Tokenize text into lowercase alphanumeric terms for lexical (BM25) scoring.
/// Unicode-aware split on non-alphanumeric characters; empty tokens dropped.
/// Model-specific subword tokenization (the G2.2 `model` argument) is deferred:
/// M2 uses one uniform tokenizer so index-time and query-time tokenization
/// always agree, which is what BM25 requires.
#[napi]
pub fn tokenize(text: String) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(str::to_lowercase)
        .collect()
}

/// BM25 contribution of one query term to one document (Robertson/Spärck-Jones,
/// Lucene-style non-negative idf). Constants k1 = 1.2, b = 0.75. The caller sums
/// this over the query's terms to score a document, keeping the native surface a
/// small, pure, composable primitive.
///
/// idf = ln(1 + (N - df + 0.5) / (df + 0.5)), always >= 0.
#[napi]
pub fn bm25_score(tf: f64, doc_len: f64, avg_doc_len: f64, doc_freq: f64, doc_count: f64) -> f64 {
    if tf <= 0.0 || doc_count <= 0.0 {
        return 0.0;
    }
    let k1 = 1.2;
    let b = 0.75;
    let idf = (1.0 + (doc_count - doc_freq + 0.5) / (doc_freq + 0.5)).ln();
    let denom = tf + k1 * (1.0 - b + b * (doc_len / avg_doc_len.max(1.0)));
    idf * (tf * (k1 + 1.0)) / denom
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_vectors() {
        let sim = cosine_similarity(vec![1.0, 2.0, 3.0], vec![1.0, 2.0, 3.0]);
        assert!((sim - 1.0).abs() < 1e-6);
    }

    #[test]
    fn orthogonal_vectors() {
        let sim = cosine_similarity(vec![1.0, 0.0], vec![0.0, 1.0]);
        assert!(sim.abs() < 1e-6);
    }

    #[test]
    fn mismatched_length() {
        assert_eq!(cosine_similarity(vec![1.0, 2.0], vec![1.0, 2.0, 3.0]), 0.0);
    }

    #[test]
    fn tokenize_basic() {
        assert_eq!(
            tokenize("Hello, World!".to_string()),
            vec!["hello", "world"]
        );
    }

    #[test]
    fn tokenize_drops_empties_and_lowercases() {
        assert_eq!(
            tokenize("  Foo--Bar  baz ".to_string()),
            vec!["foo", "bar", "baz"]
        );
    }

    #[test]
    fn bm25_zero_tf_is_zero() {
        assert_eq!(bm25_score(0.0, 100.0, 100.0, 1.0, 10.0), 0.0);
    }

    #[test]
    fn bm25_rarer_term_scores_higher() {
        let rare = bm25_score(2.0, 100.0, 100.0, 1.0, 10.0);
        let common = bm25_score(2.0, 100.0, 100.0, 9.0, 10.0);
        assert!(rare > common);
    }

    #[test]
    fn bm25_longer_doc_penalized() {
        let short = bm25_score(2.0, 50.0, 100.0, 2.0, 10.0);
        let long = bm25_score(2.0, 200.0, 100.0, 2.0, 10.0);
        assert!(short > long);
    }

    #[test]
    fn bm25_increases_with_tf() {
        let lo = bm25_score(1.0, 100.0, 100.0, 2.0, 10.0);
        let hi = bm25_score(5.0, 100.0, 100.0, 2.0, 10.0);
        assert!(hi > lo);
    }
}
