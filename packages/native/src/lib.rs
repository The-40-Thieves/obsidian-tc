#![deny(clippy::all)]

use napi_derive::napi;

/// Cosine similarity between two equal-length vectors.
///
/// Placeholder implementation. Inputs are plain JS number arrays (f64); the
/// zero-copy `Float32Array` path lands with the real vector primitives in G2.3
/// (Storage schema) and G2.5 (Release engineering). napi-rs does not implement
/// `FromNapiValue` for `Vec<f32>` (JS numbers are f64), so the binding takes
/// `Vec<f64>`. This exists only to verify the napi-rs build pipeline end-to-end.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_vectors() {
        let a = vec![1.0, 2.0, 3.0];
        let b = vec![1.0, 2.0, 3.0];
        let sim = cosine_similarity(a, b);
        assert!((sim - 1.0).abs() < 1e-6);
    }

    #[test]
    fn orthogonal_vectors() {
        let a = vec![1.0, 0.0];
        let b = vec![0.0, 1.0];
        let sim = cosine_similarity(a, b);
        assert!(sim.abs() < 1e-6);
    }

    #[test]
    fn mismatched_length() {
        let a = vec![1.0, 2.0];
        let b = vec![1.0, 2.0, 3.0];
        assert_eq!(cosine_similarity(a, b), 0.0);
    }
}
