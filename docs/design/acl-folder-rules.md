# ACL: folder rules, glob matching, and the fingerprint cache key

Extracted from inline commentary, 2026-08-21. The code carries the invariants; this note carries the history and evidence.

## Glob-cache memoization: nested Map, not a concatenated key (THE-618)

`globToRegExp` compiles on every call and sits on the per-note ACL hot path. Memoizing the
compiled regex is necessary, but the cache key shape was a deliberate choice, not the obvious one.

The cache is a **nested `Map`**: outer keyed by the exact glob string, inner keyed by the
`caseInsensitive` boolean — not a concatenated string key (e.g. `` `${glob}\0${caseInsensitive}` ``).

Why it matters: `caseInsensitive` changes the compiled `RegExp`'s flags. A cache keyed on the glob
string alone would hand a case-insensitive caller a case-sensitive compile (or vice versa,
depending on call order) — a silent ACL correctness bug, worse than the perf problem the cache
exists to fix.

A concatenated key was considered and rejected. It would work, but it reuses the NUL-sentinel
idea this file already uses for the `**` glob token (see `globToRegExp`) for an unrelated purpose,
and invites exactly the naive-string-key collision class the file's `check:nul` guard exists to
catch. Nesting on the boolean makes collision structurally impossible instead of merely unlikely:
the inner key is never a string, so it can never be misread as part of the glob.

### Bound: `GLOB_CACHE_MAX`

Globs are config-authored (`AclConfigT.rules`/`readPaths`/`writePaths`/`deletePaths`) **except**
for one caller: `audit_provenance`'s `include`/`exclude` tool args (`graph-health-tools.ts`) accept
up to 64 caller-supplied glob strings per call, unbounded across calls over the process lifetime.
An unbounded cache is therefore a real memory-growth vector, not a theoretical one.

The cache caps total entries (1000) and evicts the oldest on overflow. `Map` preserves insertion
order, so this is a cheap FIFO — an LRU is unnecessary because the goal is bounding worst-case
growth from a caller pumping distinct globs, not maximizing hit rate.

## Case-insensitivity and Unicode normalization (THE-272)

Two independent hazards, both handled by normalizing before comparison rather than trusting the
byte/case form a rule was authored in:

- **Case.** On a case-insensitive filesystem (Windows NTFS, macOS APFS) a path and its case
  variants name the *same* file, so the folder ACL must match case-insensitively there or a
  case-variant path slips past a whitelist/deny authored in canonical case. On a case-sensitive
  filesystem (Linux) case stays significant. `CASE_INSENSITIVE_FS` detects this once from
  `process.platform`, overridable for tests. The hard-denied control-directory check
  (`isDefaultDenied`) case-folds unconditionally instead — `.obsidian`/`.git`/`.trash` must be
  denied under every case variant regardless of platform, because a mis-cased root could otherwise
  alias the real one on a case-insensitive filesystem. This only ever denies *more*, never exempts,
  so it is safe on a case-sensitive filesystem too; the exempt-file check stays exact so a
  mis-cased path can never be wrongly exempted where case is significant.
- **Unicode normalization.** macOS stores filenames as NFD while a config/glob authored elsewhere
  is almost always NFC. Without normalizing both sides, an NFC deny/whitelist rule silently fails
  to match its NFD path on disk — a deny that does not deny, or an allow that wrongly denies.
  Normalizing both the glob and the path to NFC (in `globMatch`, `isDefaultDenied`, and once at
  `FolderAcl` construction for the rule globs) makes the ACL decide on the logical name, not its
  byte form.

Residual THE-272 hardening (hardlink/TOCTOU, which needs non-portable `openat`/`O_NOFOLLOW`)
remains tracked separately; symlink canonicalization landed earlier under THE-269.

## ACL fingerprint is the security-critical half of the query-cache key (THE-496)

`aclFingerprint` is the *only* thing that keeps caller A's cached retrieval results from reaching
caller B. The read predicate (`readableRel`/`scopesForPath`) is a pure function of the ACL config
plus the caller's granted scopes, so identical `(config, scopes)` provably yield the identical read
set — a shared cache entry is safe. Any difference must yield a different fingerprint (safe, at
worst over-conservative). There is no vault walk, so computing it is cheap on the hot path.

Canonicalization is exact: every set (`defaultScopes`, each rule's scopes, the path whitelists, the
caller's scopes) is sorted before hashing, but the **rules array order is preserved** —
`scopesForPath` is last-match-wins, so `[ruleA, ruleB] != [ruleB, ruleA]` under that semantics, and
reordering rules changes the effective ACL and must change the fingerprint.

## One read predicate for every search surface

`readableRel(acl, rel, grantedScopes)` is the single predicate every search, enumeration and graph
surface filters its results with, and it decides exactly what `read_note`/`read_notes` decide: the
hard default-deny roots, the folder whitelist (`readPaths` / `strictReadDefault`), **and** the
path's rule-scopes against the caller's granted scopes. Before it took the scopes, a note under a
rule-scope the caller did not hold was refused by `read_notes` yet still came back from search as a
path, a snippet, a backlink or a count. `grantedScopes` is a required parameter so a new caller
cannot silently skip it. Hidden results are dropped before pagination and before any total.
`readEnumerationUnrestricted(acl, grantedScopes)` follows the same rule: a caller missing a scope
some path declares is treated as restricted (bridge tools that cannot attribute results refuse).

The persisted permitted-path sets and prewarm bundles are keyed by `aclFingerprint`. Widening what
the predicate denies is a change to the predicate, so the fingerprint carries a predicate version:
sets built by an older predicate become unreachable rather than trusted.

`FolderAcl`'s constructor snapshots the incoming config (deep-copies the arrays) before compiling
rules, specifically so the fingerprint and the enforced rules are always computed from the *same*
frozen source — reading a live, since-mutated `cfg` for the fingerprint while the enforced rules
were compiled earlier would move the cache key without moving the ACL it claims to describe, and
two callers could then share an entry computed under a different rule set.

## Index-time and write-time read gating (THE-453)

`makeIndexReadable` resolves the *effective* ACL per vault (per-vault override, falling back to
the root default) — the same resolution the dispatch `aclResolver` performs — so a vault's
`readPaths`/`strictReadDefault` override is honored at **indexing** time, not just at retrieval
time. Closing over the root ACL for every vault previously let a path a vault-override *denies*
still be read, embedded, and sent to the embedding provider: an ingestion-time confidentiality
breach that retrieval-time filtering cannot undo. It also let a restrictive root wrongly block a
path a vault-override permits.

`makeReindexGate` is the runtime counterpart, mirroring the same boot-time resolution for the
index-on-write path. A path can be write-allowed but read-denied (`writePaths` ⊃ `readPaths`); a
write handler passes the write ACL and then calls this hook. Without the read gate, content is
chunked/embedded/shipped despite being read-invisible — the same confidentiality breach as above,
just triggered by a live write instead of the initial index. A denied path routes to `delete`
instead of `write`, so an ACL that newly denies a previously-indexed path also evicts its stale
chunks/vectors rather than stranding them.
