---
title: Compatibility promise
description: obsidian-tc installs and runs everywhere; optional components make it faster. What degrades, what never breaks, and how to check which tier you are on.
---

**The promise: installation always succeeds, and features degrade rather than fail.** A missing
optional component is never a hard error. Every optional piece is resolved at runtime, validated
before it is trusted, and silently replaced by a pure-JavaScript path when it is absent.

This is not aspirational — the degraded path is exercised in CI on every change, not merely
believed to work.

## The three tiers

| Tier | Requires | What you get |
| --- | --- | --- |
| **Baseline** | Node 24+ or Bun. Nothing else. | Everything works. Note I/O, search, indexing, all tools. |
| **Standard** | Baseline + the native module | Native note read/atomic-write, native cosine similarity, tokenizer and BM25 scoring |
| **Accelerated** | Standard + `sqlite-vec` | Vector search runs as a SQL index (`vec0`) instead of an in-process scan |

Tiers are **not** a licensing or feature split. Every tool is present at every tier; the higher
tiers change how much CPU the same work costs.

## What actually degrades

**Without the native module**, obsidian-tc uses JavaScript implementations of the same operations.
`loadNative()` only accepts the module when *every* expected export is a function — a partially
built or ABI-mismatched module is rejected rather than half-used, so the fallback stays correct
even as the native API evolves.

**Without `sqlite-vec`**, semantic search falls back to a brute-force scan: every active embedding
is decoded and scored in-process. Results are the same; the cost grows with vault size. The same
fallback also catches an embedding-model change that makes `sqlite-vec` throw, so a dimension
change degrades instead of erroring.

**Nothing degrades silently into wrongness.** The fallbacks compute the same answers more slowly —
they do not return fewer or lower-quality results.

## Checking which tier you are on

The server reports it at startup on stderr:

```
obsidian-tc 1.10.0 ready on stdio (vault main; native=on vec=on)
```

- `native=on` — the real compiled native binding is serving (Standard or better); `native=js-fallback`
  when it is not — including the case where the native *package* loaded but silently substituted its
  own pure-JS fallback internally (#857), which this line deliberately does not call `on`
- `vec=on` — `sqlite-vec` loaded (Accelerated)

`native=js-fallback` and `vec=off` together means you are on Baseline, which is a fully supported
place to be.

## Forcing the baseline path

Set `OBSIDIAN_TC_FORCE_JS_FALLBACK=1` to ignore the native module even when it is installed:

```bash
OBSIDIAN_TC_FORCE_JS_FALLBACK=1 obsidian-tc serve config.json
```

This exists so the degraded path can be tested deliberately — it is what CI uses. Reach for it when
you suspect a native/JS behavioural difference: if a bug disappears under the flag, the native path
is implicated.

Three further escape hatches share this shape but are **test-only** — unlike the flag above they are
not a supported operating mode, because each deliberately weakens a safety property:

- `OBSIDIAN_TC_FORCE_READONLY_OPEN_FALLBACK=1` forces the inspection-connection open used by
  `compact --dry-run`, `compact --into` and `doctor` onto its writable-descriptor fallback. That
  fallback cannot promise the database's bytes are unchanged, so forcing it gives up the guarantee
  those commands otherwise hold.
- `OBSIDIAN_TC_FORCE_READONLY_OPEN_THROW=1` makes the *native* readonly open attempt fail inside the
  adapter, at the first statement — where a deferred SQLite open failure actually lands — so the
  writable-fallback path can be exercised on a platform whose native open succeeds. `=construct`
  fails at construction instead. This is the inverse of the flag above, which skips the native
  attempt rather than failing it.
- `OBSIDIAN_TC_FORCE_COMPACT_INTO_FAILURE=1` (or `=busy`) makes the step after `compact --into`'s
  `VACUUM INTO` fail, so the "an incomplete copy remains at …" reporting path can be exercised
  without depending on a platform's SQLite to corrupt a fixture in a particular way;
  `=delete:<table>` instead drops one row from the copy, which is the only deterministic way to make
  verification see a real row-count mismatch (`VACUUM INTO` is faithful by construction), and
  `=count-error:<table>` makes that table's `COUNT(*)` fail on the copy, which must read as a
  verification failure rather than as the "not comparable" outcome an unavailable module earns.

None of them is gated to test builds — like `OBSIDIAN_TC_FORCE_JS_FALLBACK`, they are plain
environment reads — so the only thing keeping them out of production is not setting them.

### The read-only inspection connection, and where it is unavailable

`compact --dry-run`, `compact --into` and `doctor`'s `db.reclaimable-space` row read the database
through a **read-only** connection, so looking at a store never changes its bytes or its journal
mode. Where SQLite refuses that open, they fall back to a writable file descriptor that issues no
write statement — which is safe in every ordinary case but cannot stop SQLite performing its own
checkpoint-on-close against a WAL left dangling by an unclean shutdown.

**On macOS this fallback is the normal path, not an exception.** Under Bun, the read-only open of a
WAL-mode database fails there, so `compact` prints a one-line notice and the doctor row reports
`readonlyMode=fallback` with the consequence in its details, on every run. That is the honest state
of the inspection path on that platform rather than a fault to chase: the numbers are the same, and
the only thing given up is the byte-for-byte guarantee against a dangling WAL.

## Why you can rely on this

The baseline path is not a theoretical fallback that rots. `.github/workflows/ci-native.yml` runs a
dedicated job with `OBSIDIAN_TC_FORCE_JS_FALLBACK=1` across a host matrix, and `ci-server.yml` runs
the full suite on Ubuntu, macOS and Windows. A change that breaks the pure-JS path fails CI the same
way a change that breaks the native path does.

The optionality is enforced at **load** time, not install time: the native module and `sqlite-vec`
are resolved through `createRequire` inside a `try`/`catch`, so a missing, unbuilt or
ABI-incompatible binary returns `null` instead of throwing. The native package also ships a
`fallback.js` beside its `.node` binaries for the same reason. A platform with no prebuilt binary
therefore runs — it simply stays on Baseline.
