#![deny(clippy::all)]

//! Native perf primitives for obsidian-tc. M0 shipped `cosine_similarity` to
//! verify the napi-rs pipeline. M2 (G4.M2 / THE-178) adds the lexical-search
//! primitives the spec assigns to the native module (G2.2 component 9): a
//! tokenizer and a BM25 term-scoring function. RRF and the sqlite-vec wrapper
//! (also listed in G2.2 component 9) are deferred — RRF is a V2 hybrid-fusion
//! input not used by M2 search, and sqlite-vec is loaded as a SQLite extension
//! at the TS/db layer rather than wrapped here. Every export has a pure-JS
//! fallback on the TypeScript side, so the server runs without this module.

#[cfg(unix)]
use napi::bindgen_prelude::Buffer;
use napi::bindgen_prelude::Float32Array;
use napi_derive::napi;

/// Cosine similarity between a query and a document vector. Used by the semantic
/// brute-force recall path when the sqlite-vec extension is unavailable. The query
/// stays f64; the document arrives as a zero-copy `Float32Array` (THE-266) and each
/// element is widened f32 -> f64 in-loop, so the result is bit-identical to the
/// pure-JS `jsCosineSimilarity` fallback (guarded by a strict `===` parity test).
#[napi]
pub fn cosine_similarity(a: Vec<f64>, b: Float32Array) -> f64 {
    cosine_core(&a, &b)
}

/// Pure f64 cosine core over a query slice (f64) and a document slice (f32, widened
/// in-loop). Split from the napi entry so it stays unit-testable without a JS runtime
/// to construct a `Float32Array`.
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

// ---- Symlink-safe, TOCTOU-free vault file I/O (THE-272) ----
//
// `readNote`/`writeNoteAtomic` open a caller-supplied absolute path. The folder-ACL check upstream
// canonicalizes with realpath, but the open re-resolves the *lexical* path, so an attacker who swaps
// an intermediate directory for a symlink between the ACL check and the open can redirect the
// operation (an intermediate-directory symlink-swap TOCTOU). These primitives close that race by
// opening with NO symlink followed in ANY component and doing all I/O on the resulting fd, so the
// path is never re-resolved. On Unix: a per-component `openat(O_NOFOLLOW)` walk from the filesystem
// root (a symlink component fails with ELOOP). Unix-only: there is no openat/O_NOFOLLOW equivalent on
// stable Rust for Windows, where the compiled module omits these exports and the TS side keeps its
// pure-JS path (Node `statSync` provides the nlink guard, Windows symlink creation is admin/developer
// -mode gated, and realpath containment still applies). Vault containment is enforced separately by
// the TS ACL/realpath layer; this adds the "no symlink at open time" guarantee. Any rejection is
// surfaced as a JS error the caller maps to acl_denied. The TS side keeps a pure-JS fallback for
// hosts without the compiled module.

/// Symlink-safe read: opens `abs` following no symlink in any component, rejects a non-regular or
/// hard-linked (nlink>1) file, returns the bytes. Unix-only (see the module note above).
#[cfg(unix)]
#[napi]
pub fn safe_read_note(abs: String) -> napi::Result<Buffer> {
    safe_io::read(&abs)
}

/// Symlink-safe atomic write: walks to the parent following no symlink, writes a randomized
/// O_EXCL|O_NOFOLLOW temp, then renames it onto the target. The parent directory must already exist.
/// Unix-only (see safe_read_note).
#[cfg(unix)]
#[napi]
pub fn safe_write_note_atomic(abs: String, data: Buffer) -> napi::Result<()> {
    safe_io::write_atomic(&abs, data.as_ref())
}

#[cfg(unix)]
mod safe_io {
    use napi::bindgen_prelude::Buffer;
    use napi::Error;
    use rustix::fd::OwnedFd;
    use rustix::fs::{openat, renameat, unlinkat, AtFlags, Mode, OFlags, CWD};
    use std::io::{Read, Write};
    use std::os::unix::fs::MetadataExt;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn denied(msg: impl Into<String>) -> Error {
        Error::from_reason(msg.into())
    }

    /// Non-empty path components; reject `.` (skip), `..` (traversal), empty.
    fn components(abs: &str) -> Result<Vec<&str>, Error> {
        let mut out = Vec::new();
        for c in abs.split('/') {
            if c.is_empty() || c == "." {
                continue;
            }
            if c == ".." {
                return Err(denied("path traversal component"));
            }
            out.push(c);
        }
        if out.is_empty() {
            return Err(denied("empty path"));
        }
        Ok(out)
    }

    /// Open the parent directory of the leaf, opening each component with NOFOLLOW so a symlink
    /// component fails (ELOOP) rather than redirecting resolution.
    fn open_parent(comps: &[&str]) -> Result<OwnedFd, Error> {
        let mut dir = openat(
            CWD,
            "/",
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|e| denied(format!("open root: {e}")))?;
        for comp in &comps[..comps.len() - 1] {
            dir = openat(
                &dir,
                *comp,
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .map_err(|_| {
                denied(format!(
                    "refusing symlinked or missing path component: {comp:?}"
                ))
            })?;
        }
        Ok(dir)
    }

    pub fn read(abs: &str) -> Result<Buffer, Error> {
        let comps = components(abs)?;
        let parent = open_parent(&comps)?;
        let leaf = comps[comps.len() - 1];
        let fd = openat(
            &parent,
            leaf,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| denied("refusing symlinked or missing file"))?;
        let mut file = std::fs::File::from(fd);
        let meta = file.metadata().map_err(|e| denied(format!("fstat: {e}")))?;
        if !meta.is_file() {
            return Err(denied("not a regular file"));
        }
        if meta.nlink() > 1 {
            return Err(denied("refusing a hard-linked file (inode aliasing)"));
        }
        let mut buf = Vec::with_capacity(meta.len() as usize);
        file.read_to_end(&mut buf)
            .map_err(|e| denied(format!("read: {e}")))?;
        Ok(buf.into())
    }

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    pub fn write_atomic(abs: &str, data: &[u8]) -> Result<(), Error> {
        let comps = components(abs)?;
        let parent = open_parent(&comps)?;
        let leaf = comps[comps.len() - 1];
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
        let tmp = format!(".otc.tmp-{}-{}-{}", std::process::id(), nanos, seq);
        let fd = openat(
            &parent,
            tmp.as_str(),
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::RUSR | Mode::WUSR,
        )
        .map_err(|e| denied(format!("temp create: {e}")))?;
        let mut file = std::fs::File::from(fd);
        let res = file.write_all(data).and_then(|_| file.sync_all());
        drop(file);
        if let Err(e) = res {
            let _ = unlinkat(&parent, tmp.as_str(), AtFlags::empty());
            return Err(denied(format!("write: {e}")));
        }
        if let Err(e) = renameat(&parent, tmp.as_str(), &parent, leaf) {
            let _ = unlinkat(&parent, tmp.as_str(), AtFlags::empty());
            return Err(denied(format!("rename: {e}")));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_vectors() {
        let sim = cosine_core(&[1.0, 2.0, 3.0], &[1.0, 2.0, 3.0]);
        assert!((sim - 1.0).abs() < 1e-6);
    }

    #[test]
    fn orthogonal_vectors() {
        let sim = cosine_core(&[1.0, 0.0], &[0.0, 1.0]);
        assert!(sim.abs() < 1e-6);
    }

    #[test]
    fn mismatched_length() {
        assert_eq!(cosine_core(&[1.0, 2.0], &[1.0, 2.0, 3.0]), 0.0);
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
