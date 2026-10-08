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
use napi::bindgen_prelude::{BigInt, Buffer};
use napi::bindgen_prelude::{Float32Array, Float64Array, Int32Array};
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
///
/// `pub` for the `rlib` crate-type so `benches/` links the shipped kernel rather than a copy;
/// it is not a napi export and is not part of the JS surface.
pub fn cosine_core(a: &[f64], b: &[f32]) -> f64 {
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

/// Score a whole candidate set in ONE N-API crossing. `docs_flat` is N document vectors of
/// length `dim` concatenated (row-major, f32); returns N cosine scores in row order. The batched
/// analogue of `cosine_similarity`: on the brute-force recall path the per-call boundary cost of
/// scoring a corpus one pair at a time dominates the compute (THE-420), so retrieval crosses the
/// JS<->native boundary once for the whole candidate set instead of once per vector.
///
/// THE-504: `query` is now a zero-copy `Float32Array` (was `Vec<f64>`) so the caller marshals it
/// once as f32 instead of converting a JS `number[]` to `Vec<f64>` on every call — the same
/// zero-copy treatment `docs_flat` already got in THE-266. This narrows the query's *storage*
/// precision to f32 before it crosses the boundary (values are still widened to f64 for the
/// accumulation below, matching `cosine_core`'s arithmetic exactly). See `cosine_batch_core`'s
/// doc comment for the measured effect and the epsilon this is held to.
#[napi]
pub fn cosine_batch(query: Float32Array, docs_flat: Float32Array, dim: u32) -> Float64Array {
    Float64Array::new(cosine_batch_core(&query, &docs_flat, dim as usize))
}

/// Pure core: one f32 query vs N concatenated f32 docs, both widened to f64 for accumulation
/// (unchanged accumulator precision — see THE-504's Criterion f32-vs-f64-accumulation bench,
/// which found f32 accumulation not worth the resulting drift; f64 was kept).
///
/// THE-504 optimized this from the original "reuse `cosine_core` per doc", which recomputed the
/// query's norm on every document. Now: the query norm is computed ONCE per batch, and each
/// document's dot product and norm are computed together in a single pass (was two passes: one
/// inside `cosine_core`'s loop, conceptually redundant work per doc via the repeated query walk).
///
/// Numeric note: because `query` is now `&[f32]` (see `cosine_batch`'s doc comment), a query value
/// that was not exactly representable in f32 is rounded once, before this function ever sees it.
/// `cosine_batch_f32_query_narrowing_within_epsilon` (below) measures that rounding's effect on the
/// score directly against the old f64-query path using deliberately non-f32-representable inputs
/// (thirds, sqrt(2)) and holds it to < 1e-6 absolute. `cosine_batch_refactor_matches_naive_per_doc...`
/// isolates the *algorithm* change from the f32-narrowing and asserts it is bit-identical.
/// `pub` for the `rlib` crate-type so `benches/` links this exact function instead of a manually
/// re-copied duplicate; not a napi export and not part of the JS surface.
pub fn cosine_batch_core(query: &[f32], docs_flat: &[f32], dim: usize) -> Vec<f64> {
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

/// Length of the longest common subsequence of two INTERNED token-id sequences, in ONE N-API
/// crossing for the whole pair.
///
/// This is the inner loop of ROUGE-L stage-1 citation filtering. Two deliberate boundary choices,
/// both following THE-420's rule that a crossing must amortise over real work:
///
/// * Tokens arrive as `Int32Array`, already interned by the caller. Interning on the TS side lets
///   ONE transcript be prepared once and reused across every chunk, and keeps this a pure integer
///   kernel — the boundary cost is two typed-array views, not N string copies.
/// * Only the LCS LENGTH crosses back. The F1 arithmetic (precision, recall, harmonic mean) is
///   trivial and stays in TypeScript, so nothing but a `u32` returns.
///
/// A token id present in `a` but absent from `b` must never compare equal to any element of `b`;
/// the caller supplies a negative sentinel for that. This function only ever compares `a[i]` to
/// `b[j]`, never two elements of `a`, so a shared sentinel is safe.
#[napi]
pub fn rouge_l_lcs(a: Int32Array, b: Int32Array) -> u32 {
    rouge_l_lcs_core(&a, &b)
}

/// Pure core: two-row LCS DP over flat `i32` buffers. Split from the napi entry so it is unit
/// testable without a JS runtime, and `pub` for the `rlib` crate-type, matching `cosine_batch_core`.
///
/// Rows are swapped rather than reallocated, so the DP allocates exactly twice regardless of
/// `a.len()`. `curr[0]` is never written and stays 0, which is the LCS base case. After a swap
/// `curr` holds two-rows-ago values, but every `curr[j]` for `j >= 1` is written before it is read
/// as `curr[j - 1]` later in the same pass, so no stale value survives.
pub fn rouge_l_lcs_core(a: &[i32], b: &[i32]) -> u32 {
    if a.is_empty() || b.is_empty() {
        return 0;
    }
    let n = b.len();
    let mut prev = vec![0u32; n + 1];
    let mut curr = vec![0u32; n + 1];
    for &ai in a {
        for j in 1..=n {
            curr[j] = if ai == b[j - 1] {
                prev[j - 1] + 1
            } else {
                prev[j].max(curr[j - 1])
            };
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    prev[n]
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

/// A configured folder the server pinned when it built its vault registry: `dir` is the real
/// directory (absolute, an ancestor of the path being opened) and `dev` / `ino` its identity then.
/// The walk opens `dir` component by component with O_NOFOLLOW like any other path, then fstats the
/// opened directory and refuses on a different identity, so a directory renamed into the pinned
/// name after the server's ACL decision is never opened through the pin.
#[cfg(unix)]
#[napi(object)]
pub struct PinnedDir {
    pub dir: String,
    pub dev: BigInt,
    pub ino: BigInt,
}

/// True on a module whose safe-open takes a `PinnedDir`: an older binary silently ignores the
/// extra argument, so the server only passes a pin (and so only opens a pinned path) when this is set.
#[cfg(unix)]
#[napi]
pub const SAFE_IO_PINNED_DIR: bool = true;

#[cfg(unix)]
fn pin_of(pinned: Option<PinnedDir>) -> napi::Result<Option<safe_io::Pin>> {
    let Some(p) = pinned else { return Ok(None) };
    let word = |b: &BigInt, what: &str| match b.get_u64() {
        (false, v, true) => Ok(v),
        _ => Err(napi::Error::from_reason(format!(
            "pinned folder {what} is not an unsigned 64-bit value"
        ))),
    };
    Ok(Some(safe_io::Pin {
        dev: word(&p.dev, "dev")?,
        ino: word(&p.ino, "ino")?,
        dir: p.dir,
    }))
}

/// Symlink-safe read: opens `abs` following no symlink in any component, rejects a non-regular or
/// hard-linked (nlink>1) file, returns the bytes. With `pinned`, the pinned directory component must
/// still be the directory it was pinned as (see `PinnedDir`). Unix-only (see the module note above).
#[cfg(unix)]
#[napi]
pub fn safe_read_note(abs: String, pinned: Option<PinnedDir>) -> napi::Result<Buffer> {
    safe_io::read(&abs, pin_of(pinned)?.as_ref())
}

/// Symlink-safe atomic write: walks to the parent following no symlink, writes a randomized
/// O_EXCL|O_NOFOLLOW temp, then renames it onto the target. The parent directory must already exist.
/// Unix-only (see safe_read_note).
#[cfg(unix)]
#[napi]
pub fn safe_write_note_atomic(abs: String, data: Buffer) -> napi::Result<()> {
    safe_io::write_atomic(&abs, data.as_ref())
}

/// Symlink-safe atomic write that REFUSES to replace: same as `safe_write_note_atomic`, but the
/// final step is a no-replace rename (Linux `renameat2(RENAME_NOREPLACE)`, macOS
/// `renameatx_np(RENAME_EXCL)`, else `linkat` + `unlinkat`), so an `overwrite: false` caller cannot
/// lose a race to a concurrent creator of the same path (a check-then-rename leaves that window
/// open). An existing target is an error whose message starts with `exists:`. Unix-only.
#[cfg(unix)]
#[napi]
pub fn safe_write_note_exclusive(abs: String, data: Buffer) -> napi::Result<()> {
    safe_io::write_exclusive(&abs, data.as_ref())
}

/// Symlink-safe no-replace rename of `from_abs` onto `to_abs`: each parent is opened following no
/// symlink in any component, then the leaf is renamed with RENAME_NOREPLACE semantics (see
/// `safe_write_note_exclusive`). Used to move a note into `.trash/` and to put it back on rollback,
/// so a planted `.trash` symlink cannot redirect either leg. An existing target is an error whose
/// message starts with `exists:`. Each leg takes its own optional `PinnedDir`. Unix-only.
#[cfg(unix)]
#[napi]
pub fn safe_rename_no_replace(
    from_abs: String,
    to_abs: String,
    from_pinned: Option<PinnedDir>,
    to_pinned: Option<PinnedDir>,
) -> napi::Result<()> {
    safe_io::rename_no_replace(
        &from_abs,
        &to_abs,
        pin_of(from_pinned)?.as_ref(),
        pin_of(to_pinned)?.as_ref(),
    )
}

#[cfg(unix)]
mod safe_io {
    use napi::Error;
    use napi::bindgen_prelude::Buffer;
    use rustix::fd::OwnedFd;
    use rustix::fs::{AtFlags, CWD, Mode, OFlags, linkat, openat, renameat, unlinkat};
    use rustix::io::Errno;
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

    /// A pinned directory (see `PinnedDir`), its identity as two plain words.
    pub struct Pin {
        pub dir: String,
        pub dev: u64,
        pub ino: u64,
    }

    /// How many leading components of `comps` the pin covers: it must be a strict ancestor of the
    /// leaf, so the walk below opens it as a directory.
    fn pinned_depth(comps: &[&str], pin: &Pin) -> Result<usize, Error> {
        let dir = components(&pin.dir)?;
        if dir.len() >= comps.len() || comps[..dir.len()] != dir[..] {
            return Err(denied("the pinned folder is not an ancestor of the path"));
        }
        Ok(dir.len())
    }

    /// fstat the opened directory: refuse it unless it is still the directory that was pinned.
    fn still_pinned(dir: OwnedFd, pin: &Pin) -> Result<OwnedFd, Error> {
        let file = std::fs::File::from(dir);
        let meta = file.metadata().map_err(|e| denied(format!("fstat: {e}")))?;
        if meta.dev() != pin.dev || meta.ino() != pin.ino {
            return Err(denied(
                "refusing a pinned folder that is no longer the directory it was pinned as",
            ));
        }
        Ok(OwnedFd::from(file))
    }

    /// Open the parent directory of the leaf, opening each component with NOFOLLOW so a symlink
    /// component fails (ELOOP) rather than redirecting resolution. With `pin`, the component that
    /// completes the pinned directory is checked against its identity right after it is opened.
    fn open_parent(comps: &[&str], pin: Option<&Pin>) -> Result<OwnedFd, Error> {
        let depth = pin.map(|p| pinned_depth(comps, p)).transpose()?;
        let mut dir = openat(
            CWD,
            "/",
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|e| denied(format!("open root: {e}")))?;
        for (i, comp) in comps[..comps.len() - 1].iter().enumerate() {
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
            if let (Some(d), Some(p)) = (depth, pin)
                && d == i + 1
            {
                dir = still_pinned(dir, p)?;
            }
        }
        Ok(dir)
    }

    pub fn read(abs: &str, pin: Option<&Pin>) -> Result<Buffer, Error> {
        let comps = components(abs)?;
        let parent = open_parent(&comps, pin)?;
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

    /// Rename `old` (in `old_dir`) onto `new` (in `new_dir`) WITHOUT replacing an existing `new`.
    /// Linux/macOS use the kernel's atomic no-replace rename; a filesystem that lacks it (EINVAL /
    /// ENOSYS / ENOTSUP) and every other Unix fall back to `linkat` (which fails EEXIST
    /// atomically) then `unlinkat` of the old name.
    fn rename_noreplace(
        old_dir: &OwnedFd,
        old: &str,
        new_dir: &OwnedFd,
        new: &str,
    ) -> Result<(), Errno> {
        #[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
        {
            use rustix::fs::{RenameFlags, renameat_with};
            match renameat_with(old_dir, old, new_dir, new, RenameFlags::NOREPLACE) {
                Err(Errno::INVAL) | Err(Errno::NOSYS) | Err(Errno::NOTSUP) => {}
                other => return other,
            }
        }
        link_then_unlink(old_dir, old, new_dir, new, || {
            unlinkat(old_dir, old, AtFlags::empty())
        })
    }

    /// `linkat` the old name to the new one (fails EEXIST atomically), then drop the old name via
    /// `unlink_old`. If the old name cannot be dropped the caller is told the move FAILED, so the
    /// new link is removed again: an error must never leave the bytes under both names with the
    /// destination already holding them (the caller would retry or roll back against a file that
    /// is in fact there).
    pub(super) fn link_then_unlink(
        old_dir: &OwnedFd,
        old: &str,
        new_dir: &OwnedFd,
        new: &str,
        unlink_old: impl FnOnce() -> Result<(), Errno>,
    ) -> Result<(), Errno> {
        linkat(old_dir, old, new_dir, new, AtFlags::empty())?;
        if let Err(e) = unlink_old() {
            let _ = unlinkat(new_dir, new, AtFlags::empty());
            return Err(e);
        }
        Ok(())
    }

    fn rename_error(e: Errno) -> Error {
        if e == Errno::EXIST {
            denied("exists: destination already exists")
        } else {
            denied(format!("rename: {e}"))
        }
    }

    pub fn rename_no_replace(
        from: &str,
        to: &str,
        from_pin: Option<&Pin>,
        to_pin: Option<&Pin>,
    ) -> Result<(), Error> {
        let from_comps = components(from)?;
        let to_comps = components(to)?;
        let from_parent = open_parent(&from_comps, from_pin)?;
        let to_parent = open_parent(&to_comps, to_pin)?;
        rename_noreplace(
            &from_parent,
            from_comps[from_comps.len() - 1],
            &to_parent,
            to_comps[to_comps.len() - 1],
        )
        .map_err(rename_error)
    }

    pub fn write_atomic(abs: &str, data: &[u8]) -> Result<(), Error> {
        write_impl(abs, data, false)
    }

    pub fn write_exclusive(abs: &str, data: &[u8]) -> Result<(), Error> {
        write_impl(abs, data, true)
    }

    fn write_impl(abs: &str, data: &[u8], no_replace: bool) -> Result<(), Error> {
        let comps = components(abs)?;
        let parent = open_parent(&comps, None)?;
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
        let renamed = if no_replace {
            rename_noreplace(&parent, tmp.as_str(), &parent, leaf)
        } else {
            renameat(&parent, tmp.as_str(), &parent, leaf)
        };
        if let Err(e) = renamed {
            let _ = unlinkat(&parent, tmp.as_str(), AtFlags::empty());
            return Err(rename_error(e));
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
    fn cosine_batch_scores_rows_in_order() {
        let scores = cosine_batch_core(&[1.0_f32, 0.0], &[1.0, 0.0, 0.0, 1.0], 2);
        assert_eq!(scores.len(), 2);
        assert!((scores[0] - 1.0).abs() < 1e-6);
        assert!(scores[1].abs() < 1e-6);
    }

    #[test]
    fn cosine_batch_matches_per_pair() {
        let q_f32: [f32; 3] = [0.1, 0.2, 0.3];
        let q_f64: Vec<f64> = q_f32.iter().map(|&x| x as f64).collect();
        let docs: [f32; 6] = [0.2, 0.1, 0.4, 0.9, 0.0, 0.1];
        let batch = cosine_batch_core(&q_f32, &docs, 3);
        assert_eq!(batch[0], cosine_core(&q_f64, &docs[0..3]));
        assert_eq!(batch[1], cosine_core(&q_f64, &docs[3..6]));
    }

    #[test]
    fn cosine_batch_rejects_bad_shape() {
        // dimension mismatch (query.len() != dim)
        assert!(cosine_batch_core(&[1.0_f32, 2.0], &[1.0, 2.0, 3.0], 2).is_empty());
        // non-multiple docs_flat.len() % dim != 0
        assert!(cosine_batch_core(&[1.0_f32], &[1.0, 2.0], 2).is_empty());
        // dim == 0
        assert!(cosine_batch_core(&[] as &[f32], &[], 0).is_empty());
    }

    #[test]
    fn cosine_batch_empty_docs_flat_is_empty_not_error() {
        let scores = cosine_batch_core(&[1.0_f32, 2.0, 3.0], &[], 3);
        assert!(scores.is_empty());
    }

    #[test]
    fn cosine_batch_single_doc() {
        let scores = cosine_batch_core(&[1.0_f32, 2.0, 3.0], &[1.0, 2.0, 3.0], 3);
        assert_eq!(scores.len(), 1);
        assert!((scores[0] - 1.0).abs() < 1e-6);
    }

    #[test]
    fn cosine_batch_zero_query_vector_is_all_zero_scores() {
        // norm_q == 0 must short-circuit to zeros rather than dividing by zero (NaN).
        let scores = cosine_batch_core(&[0.0_f32, 0.0], &[1.0, 2.0, 3.0, 4.0], 2);
        assert_eq!(scores, vec![0.0, 0.0]);
    }

    #[test]
    fn cosine_batch_zero_doc_vector_scores_zero_others_unaffected() {
        // A zero-norm document must score 0 (not NaN) without perturbing sibling rows.
        let scores = cosine_batch_core(&[1.0_f32, 0.0], &[0.0, 0.0, 1.0, 0.0], 2);
        assert_eq!(scores.len(), 2);
        assert_eq!(scores[0], 0.0);
        assert!((scores[1] - 1.0).abs() < 1e-6);
    }

    /// THE-504: isolates the ALGORITHM change (query norm precomputed once + single-pass
    /// dot/norm per doc) from the TYPE change (query narrowed to f32). Query values here are
    /// exactly representable in f32, so the narrowing is a no-op, and the refactored batch core
    /// must be bit-identical to the naive "reuse cosine_core per doc" it replaced.
    #[test]
    fn cosine_batch_refactor_matches_naive_per_doc_when_query_is_exact_f32() {
        let query_f32: [f32; 4] = [0.5, -0.25, 2.0, 0.125];
        let query_f64: Vec<f64> = query_f32.iter().map(|&q| q as f64).collect();
        let docs: [f32; 12] = [1.0, 2.0, 3.0, 4.0, 0.5, -1.5, 2.5, 0.0, -3.0, 4.0, 1.0, 0.0];
        let dim = 4;
        let naive: Vec<f64> = docs
            .chunks_exact(dim)
            .map(|d| cosine_core(&query_f64, d))
            .collect();
        let refactored = cosine_batch_core(&query_f32, &docs, dim);
        assert_eq!(
            naive, refactored,
            "algorithm refactor alone must be bit-identical"
        );
    }

    /// THE-504: measures the f32-narrowing effect from item 2 (query: Vec<f64> -> Float32Array)
    /// directly. Compares the OLD per-pair path (full f64 query via cosine_core, no narrowing)
    /// against the NEW batch path fed the SAME values after an f32 round-trip (what constructing
    /// a JS Float32Array from a number[] does at the boundary). Deliberately non-f32-representable
    /// values (thirds, sqrt(2), an irrational-ish decimal) are used to surface the largest
    /// plausible drift. Held to < 1e-6 absolute — see the report for the measured value.
    #[test]
    fn cosine_batch_f32_query_narrowing_within_epsilon() {
        let query_f64: Vec<f64> = vec![1.0 / 3.0, 2.0_f64.sqrt(), 0.1, 123.456_789, -7.0 / 9.0];
        let query_f32_narrowed: Vec<f32> = query_f64.iter().map(|&q| q as f32).collect();
        let docs: [f32; 10] = [0.2, 1.4, 0.05, 100.0, -0.5, -0.3, 0.9, 0.2, 50.0, 0.11];
        let dim = 5;
        let old_scores: Vec<f64> = docs
            .chunks_exact(dim)
            .map(|doc| cosine_core(&query_f64, doc))
            .collect();
        let new_scores = cosine_batch_core(&query_f32_narrowed, &docs, dim);
        assert_eq!(old_scores.len(), new_scores.len());
        // Measured: diff ~4e-13 and ~2.8e-12 for these two docs (near machine-epsilon territory for
        // f64, not a meaningful precision loss) — see the ticket report for the full finding,
        // including a wider random-vector spot-check (max ~6.4e-11 across 20 docs at dim=64).
        for (old, new) in old_scores.iter().zip(new_scores.iter()) {
            let diff = (old - new).abs();
            assert!(
                diff < 1e-6,
                "f32 query narrowing drift too large: old={old} new={new} diff={diff}"
            );
        }
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

    /// Textbook full-table LCS. Deliberately the naive O(n*m) SPACE version: it is the oracle the
    /// two-row optimisation is checked against, so it must not share the row-swapping logic under
    /// test.
    fn lcs_oracle(a: &[i32], b: &[i32]) -> u32 {
        let mut t = vec![vec![0u32; b.len() + 1]; a.len() + 1];
        for i in 1..=a.len() {
            for j in 1..=b.len() {
                t[i][j] = if a[i - 1] == b[j - 1] {
                    t[i - 1][j - 1] + 1
                } else {
                    t[i - 1][j].max(t[i][j - 1])
                };
            }
        }
        t[a.len()][b.len()]
    }

    #[test]
    fn rouge_l_lcs_basic_shapes() {
        assert_eq!(rouge_l_lcs_core(&[], &[1, 2, 3]), 0);
        assert_eq!(rouge_l_lcs_core(&[1, 2, 3], &[]), 0);
        assert_eq!(rouge_l_lcs_core(&[], &[]), 0);
        assert_eq!(rouge_l_lcs_core(&[1, 2, 3], &[1, 2, 3]), 3); // identical
        assert_eq!(rouge_l_lcs_core(&[1, 2, 3], &[4, 5, 6]), 0); // disjoint
        assert_eq!(rouge_l_lcs_core(&[1, 2, 3, 4], &[2, 4]), 2); // subsequence, not substring
        assert_eq!(rouge_l_lcs_core(&[1, 2, 3], &[3, 2, 1]), 1); // order matters
    }

    #[test]
    fn rouge_l_lcs_negative_sentinel_never_matches() {
        // The TS caller maps a chunk token absent from the transcript to -1. Two such tokens must
        // not match each other, and -1 must not match any real (non-negative) id.
        assert_eq!(rouge_l_lcs_core(&[-1, -1], &[0, 1, 2]), 0);
        assert_eq!(rouge_l_lcs_core(&[-1, 1, -1], &[0, 1, 2]), 1);
    }

    #[test]
    fn rouge_l_lcs_matches_full_table_oracle_on_pseudorandom_inputs() {
        // Deterministic xorshift so a failure is reproducible without a rand dependency.
        let mut state: u64 = 0x2545_F491_4F6C_DD1D;
        let mut next = move |m: i32| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 33) as i32 % m
        };
        for case in 0..40 {
            let la = 1 + (case * 7) % 23;
            let lb = 1 + (case * 11) % 29;
            // A small alphabet forces frequent matches; a large one forces sparse matches.
            let alphabet = if case % 2 == 0 { 3 } else { 17 };
            let a: Vec<i32> = (0..la).map(|_| next(alphabet)).collect();
            let b: Vec<i32> = (0..lb).map(|_| next(alphabet)).collect();
            assert_eq!(
                rouge_l_lcs_core(&a, &b),
                lcs_oracle(&a, &b),
                "case {case}: a={a:?} b={b:?}"
            );
        }
    }

    #[test]
    fn rouge_l_lcs_is_bounded_by_the_shorter_input() {
        let a: Vec<i32> = (0..50).collect();
        let b: Vec<i32> = (0..10).collect();
        let l = rouge_l_lcs_core(&a, &b);
        assert!(l <= a.len().min(b.len()) as u32);
        assert_eq!(l, 10);
    }
}

/// Symlink-safe no-replace write / rename (Unix). Each test works in its own scratch directory
/// under the OS temp dir (no tempfile dependency in this crate), removed at the end.
#[cfg(all(test, unix))]
mod safe_io_tests {
    use super::safe_io;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(0);

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "otc-native-noreplace-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        // Canonical path: safe_io refuses a symlink in ANY component (macOS /var -> /private/var).
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    fn s(p: &std::path::Path) -> String {
        p.to_str().unwrap().to_string()
    }

    #[test]
    fn write_exclusive_creates_a_missing_target() {
        let d = scratch();
        safe_io::write_exclusive(&s(&d.join("a.md")), b"one").unwrap();
        assert_eq!(fs::read(d.join("a.md")).unwrap(), b"one");
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn write_exclusive_never_replaces_and_leaves_no_temp() {
        let d = scratch();
        fs::write(d.join("a.md"), b"original").unwrap();
        let e = safe_io::write_exclusive(&s(&d.join("a.md")), b"clobber").unwrap_err();
        assert!(e.reason.starts_with("exists:"), "got {}", e.reason);
        assert_eq!(fs::read(d.join("a.md")).unwrap(), b"original");
        let names: Vec<_> = fs::read_dir(&d)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names.len(), 1, "temp file leaked: {names:?}");
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn write_atomic_still_replaces() {
        let d = scratch();
        fs::write(d.join("a.md"), b"original").unwrap();
        safe_io::write_atomic(&s(&d.join("a.md")), b"new").unwrap();
        assert_eq!(fs::read(d.join("a.md")).unwrap(), b"new");
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn rename_no_replace_moves_and_refuses_an_occupied_target() {
        let d = scratch();
        fs::write(d.join("from.md"), b"payload").unwrap();
        fs::write(d.join("taken.md"), b"taken").unwrap();
        let e =
            safe_io::rename_no_replace(&s(&d.join("from.md")), &s(&d.join("taken.md")), None, None)
                .unwrap_err();
        assert!(e.reason.starts_with("exists:"), "got {}", e.reason);
        assert_eq!(fs::read(d.join("from.md")).unwrap(), b"payload");
        assert_eq!(fs::read(d.join("taken.md")).unwrap(), b"taken");
        safe_io::rename_no_replace(&s(&d.join("from.md")), &s(&d.join("free.md")), None, None)
            .unwrap();
        assert!(!d.join("from.md").exists());
        assert_eq!(fs::read(d.join("free.md")).unwrap(), b"payload");
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn rename_no_replace_refuses_a_symlinked_destination_directory() {
        use std::os::unix::fs::symlink;
        let d = scratch();
        let outside = scratch();
        fs::write(d.join("note.md"), b"payload").unwrap();
        // `.trash` planted as a symlink to a directory outside the vault.
        symlink(&outside, d.join(".trash")).unwrap();
        let r = safe_io::rename_no_replace(
            &s(&d.join("note.md")),
            &s(&d.join(".trash/note.md")),
            None,
            None,
        );
        assert!(r.is_err(), "rename followed a planted symlink");
        assert!(d.join("note.md").exists());
        assert!(!outside.join("note.md").exists());
        fs::remove_dir_all(&d).unwrap();
        fs::remove_dir_all(&outside).unwrap();
    }

    #[test]
    fn write_exclusive_refuses_a_symlinked_ancestor() {
        use std::os::unix::fs::symlink;
        let d = scratch();
        let outside = scratch();
        symlink(&outside, d.join("sub")).unwrap();
        let r = safe_io::write_exclusive(&s(&d.join("sub/n.md")), b"x");
        assert!(r.is_err());
        assert!(!outside.join("n.md").exists());
        fs::remove_dir_all(&d).unwrap();
        fs::remove_dir_all(&outside).unwrap();
    }

    /// The hard-link fallback of `rename_noreplace`: if the old name cannot be dropped after the
    /// link landed, the caller is told the move FAILED, so the new name must not keep the bytes.
    #[test]
    fn link_fallback_undoes_the_new_name_when_the_old_one_cannot_be_dropped() {
        use rustix::fs::{CWD, Mode, OFlags, openat};
        use rustix::io::Errno;
        let d = scratch();
        fs::write(d.join("from.md"), b"payload").unwrap();
        let dir = openat(
            CWD,
            d.to_str().unwrap(),
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .unwrap();
        let r = safe_io::link_then_unlink(&dir, "from.md", &dir, "to.md", || Err(Errno::BUSY));
        assert_eq!(r, Err(Errno::BUSY));
        assert_eq!(fs::read(d.join("from.md")).unwrap(), b"payload");
        assert!(
            !d.join("to.md").exists(),
            "the destination kept the bytes although the caller saw an error"
        );
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn link_fallback_moves_when_the_old_name_is_dropped() {
        use rustix::fs::{AtFlags, CWD, Mode, OFlags, openat, unlinkat};
        let d = scratch();
        fs::write(d.join("from.md"), b"payload").unwrap();
        let dir = openat(
            CWD,
            d.to_str().unwrap(),
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .unwrap();
        safe_io::link_then_unlink(&dir, "from.md", &dir, "to.md", || {
            unlinkat(&dir, "from.md", AtFlags::empty())
        })
        .unwrap();
        assert!(!d.join("from.md").exists());
        assert_eq!(fs::read(d.join("to.md")).unwrap(), b"payload");
        fs::remove_dir_all(&d).unwrap();
    }

    /// The pin of `dir` as it is now.
    fn pin(dir: &std::path::Path) -> safe_io::Pin {
        use std::os::unix::fs::MetadataExt;
        let m = fs::metadata(dir).unwrap();
        safe_io::Pin {
            dir: s(dir),
            dev: m.dev(),
            ino: m.ino(),
        }
    }

    /// `open` pinned, then renamed away and `raw` renamed into its name: same pathname, another
    /// directory. Both the read and the move must refuse it; with the identity intact both work.
    #[test]
    fn a_pinned_directory_replaced_under_its_name_is_refused() {
        let d = scratch();
        for (dir, body) in [("open", b"open note"), ("raw", b"RAW SRC!!")] {
            fs::create_dir(d.join(dir)).unwrap();
            fs::write(d.join(dir).join("x.md"), body).unwrap();
        }
        let open = pin(&d.join("open"));
        let x = s(&d.join("open/x.md"));
        assert_eq!(
            safe_io::read(&x, Some(&open)).unwrap().as_ref(),
            b"open note"
        );
        fs::rename(d.join("open"), d.join("gone")).unwrap();
        fs::rename(d.join("raw"), d.join("open")).unwrap();
        let Err(e) = safe_io::read(&x, Some(&open)) else {
            panic!("read through a replaced pinned folder");
        };
        assert!(
            e.reason.contains("no longer the directory"),
            "got {}",
            e.reason
        );
        assert!(
            safe_io::read(&x, None).is_ok(),
            "control: unpinned, the path itself is fine"
        );
        let moved = s(&d.join("moved.md"));
        assert!(safe_io::rename_no_replace(&x, &moved, Some(&open), None).is_err());
        assert!(safe_io::rename_no_replace(&moved, &x, None, Some(&open)).is_err());
        assert_eq!(fs::read(d.join("open/x.md")).unwrap(), b"RAW SRC!!");
        let now = pin(&d.join("open"));
        safe_io::rename_no_replace(&x, &moved, Some(&now), None).unwrap();
        assert_eq!(fs::read(d.join("moved.md")).unwrap(), b"RAW SRC!!");
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn a_pin_that_is_not_a_strict_ancestor_is_refused() {
        let d = scratch();
        fs::create_dir(d.join("open")).unwrap();
        fs::create_dir(d.join("other")).unwrap();
        fs::write(d.join("other/x.md"), b"x").unwrap();
        let open = pin(&d.join("open"));
        for path in [d.join("other/x.md"), d.join("open")] {
            let Err(e) = safe_io::read(&s(&path), Some(&open)) else {
                panic!("read with a pin that is not an ancestor");
            };
            assert!(e.reason.contains("not an ancestor"), "got {}", e.reason);
        }
        fs::remove_dir_all(&d).unwrap();
    }
}
