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

- `native=on` — the native module loaded (Standard or better)
- `vec=on` — `sqlite-vec` loaded (Accelerated)

Both `off` means you are on Baseline, which is a fully supported place to be.

## Forcing the baseline path

Set `OBSIDIAN_TC_FORCE_JS_FALLBACK=1` to ignore the native module even when it is installed:

```bash
OBSIDIAN_TC_FORCE_JS_FALLBACK=1 obsidian-tc serve config.json
```

This exists so the degraded path can be tested deliberately — it is what CI uses. Reach for it when
you suspect a native/JS behavioural difference: if a bug disappears under the flag, the native path
is implicated.

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
