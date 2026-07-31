# ADR: disposition of `VaultBackend` / `FilesystemBackend`

| | |
|---|---|
| **Status** | Evidence recorded. **Decision pending owner sign-off.** No code changed. |
| **Date** | 2026-07-30 |
| **Verified against** | `main` @ `7567575` |
| **Scope** | WP0.2 of `2026-07-30-codebase-refactor-map.md` |
| **Supersedes nothing** | Annotates `2026-06-25-headless-vaultbackend-adr.md` (THE-255), which stays the record of the original design intent |

## Why this ADR exists

`scripts/check-boundaries.mjs` carries a permanent exemption:

```js
["packages/server/src/vault/backend.ts", "FilesystemBackend — tested, never constructed in src/"],
```

That entry is honest and deliberate — it is not an undiscovered defect. But an allowlist entry with
no expiry is a decision deferred indefinitely, and the refactor map's completion criteria require the
unreachable-production allowlist to be **empty**. This ADR gathers the evidence needed to close it
and stops there. It deliberately does **not** implement either branch: an evidence-gathering commit
that also deletes a public class is two changes wearing one hat.

## The question, stated so it can be answered

Not *"is this abstraction nice?"* — that question has no falsifiable answer. The operative question is:

> **Do two or more distinct production operations need to select at runtime between two named
> production implementations of `VaultBackend`?**

Tests, mocks, hypothetical remote/S3/in-memory storage, and merely sharing filesystem helpers all
count as **zero**. An interface justified only by a mock is a false boundary: it imposes indirection
on every reader while guaranteeing nothing, because the second implementation that would give it
meaning does not exist.

## Evidence

### Q1 — production selection points

```
rg -n --glob '*.ts' --glob '!**/*.test.ts' --glob '!**/test/**' \
  '(implements\s+VaultBackend|:\s*VaultBackend\b|new\s+FilesystemBackend\b)' packages/server/src
```

**1 hit**, and it is the class declaring itself:

```
packages/server/src/vault/backend.ts:47:export class FilesystemBackend implements VaultBackend {
```

| measure | count |
|---|---:|
| `new FilesystemBackend(...)` anywhere in production | **0** |
| Second production implementation of `VaultBackend` | **0** |
| `VaultBackend` referenced as a type outside `backend.ts` | **0** |
| Files in the repo referencing either symbol | **2** (`backend.ts`, `test/vault-backend.test.ts`) |

### Q2 — production paths that bypass the seam

```
rg --glob '*.ts' --glob '!**/*.test.ts' --glob '!**/test/**' \
  '\b(readNote|writeNoteAtomic|trashNote|hardDelete|noteExists|walkVault)\s*\(' packages/server/src
```

**33 distinct production files. 215 call sites, across 214 matching lines.** Both figures are stated
because they measure different things and are easy to conflate: `rg -o` counts *occurrences* (215),
`rg -c` counts *matching lines* (214). The single-line difference is
`tools/m5/capture-tools.ts`, which has 3 occurrences on 2 lines. Per-file counts below are
**lines**, so they sum to 214.

| file | lines |
|---|---:|
| `tools/m1/notes-tools.ts` | 38 |
| `tools/m6/bulk-tools.ts` | 17 |
| `tools/m3/periodic-tools.ts` | 13 |
| `tools/m3/base-tools.ts` | 12 |
| `tools/m1/tags-tools.ts` | 12 |
| *remaining 28 files* | 122 |

Distribution, computed rather than eyeballed:

- top 5 files carry **92 of 214** lines — **42.99%**
- the tool layer (`src/tools/**`) carries **175 of 214** lines — **81.78%** — across **22 of 33**
  files (**66.67%**)
- mean **6.48** lines per file

So production does not merely fail to *select* a backend; it does not route through the seam at all,
and the bypass is concentrated in the tool layer rather than scattered. That matters for the wire
branch: migrating it would mean changing the layer that also owns ACL and HITL enforcement.

### Reachability from the published artifact

`packages/server/package.json` publishes `exports: { ".": "./dist/index.js" }` with
`files: ["dist", "README.md", "SKILLS.md", "LICENSE"]`. `backend.ts` has **no importer anywhere in
`src/`**, so it cannot be reachable from the published entry point. Removing it is therefore **not a
breaking change to any consumer of the npm package.**

## Decision criteria

### Wire branch — adopt only if ALL hold

1. ≥2 distinct production operations require runtime selection between **two named production
   implementations**.
2. A second production implementation actually exists. No interface justified by mocks alone.
3. The composition root constructs one backend per vault and injects it into every operation
   inventoried in Q1.
4. The Q2 bypass query returns **no** matches inside the migrated operations.
5. ACL enforcement stays at the governed caller boundary; index-on-write fires exactly once per
   mutation (not once per layer).
6. Both implementations pass one shared contract test suite.
7. `backend.ts` becomes reachable and its `UNREACHABLE_ALLOWLIST` entry is deleted.
8. `ARCHITECTURE.md` and the THE-255 ADR describe construction that actually happens.

### Delete branch — adopt if EITHER holds

1. Fewer than two qualifying operations, **or**
2. No second production implementation exists.

Then: remove `VaultBackend`, `FilesystemBackend`, `ReindexHook`, the class-only test
(`test/vault-backend.test.ts`), and the `UNREACHABLE_ALLOWLIST` entry. Keep `notes-io` / `paths`
behaviour and the existing index-on-write tests green. Correct the THE-255 ADR and the architecture
text so neither claims a backend seam that does not exist. `bun run check:boundaries` must report no
new unreachable module.

## What the evidence indicates

**Every input is zero.** No second implementation, no production type reference, no construction
site, and 215 call sites routing around the seam. Criterion 2 of the delete branch is satisfied
outright, and criterion 1 is satisfied with a wide margin.

The evidence therefore points at **delete**, and it is not a close call.

Two honest counterpoints, recorded so the decision is made with them in view rather than despite them:

- The THE-255 ADR's *headless* goal was real and was delivered — but it was delivered by
  `notes-io`/`paths` running filesystem-native, **not** by this interface. Deleting the interface does
  not retract headless operation.
- If a genuine second backend is ever wanted, reintroducing the interface at that point is cheap and
  will be shaped by the real second implementation's requirements rather than guessed in advance.
  That is strictly better than preserving a guess. This is the refactor map's constraint 6 — no new
  abstraction without a second production implementation — applied to an abstraction that predates
  the constraint.

## Not decided here

The owner signs off on the branch. The implementing PR is separate from this one, so that the
evidence and the deletion can be reviewed — and if necessary reverted — independently.

## Revisit trigger

Reopen if a second production `VaultBackend` implementation is proposed, or if the Q1 inventory ever
returns ≥2 production operations needing runtime selection. Re-run both queries above rather than
trusting these counts; `rg` output is a point-in-time measurement, and the whole reason this ADR
exists is that a documented claim outlived the code it described.
