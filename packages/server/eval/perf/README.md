# THE-459/THE-503: Synthetic-Vault Perf Harness

A deterministic, CI-gated benchmark for obsidian-tc, isolated from the live-model golden-set evaluation. Measures indexing throughput, embedding efficiency, graph-search recall/nDCG, dispatch latency, storage overhead, runtime memory/eventloop health, and database lifecycle metrics over a seeded synthetic vault.

## Quick Start

From `packages/server`:

```bash
# Dev-fast single-shot (one process, one sample) -- for iterating locally
bun run perf
bun run perf:gate

# THE-503: isolated (5 fresh subprocess samples, gated on the median, contention-checked) --
# what CI actually runs. Slower; use this before trusting a number.
bun run perf:isolated
bun run perf:gate:isolated
```

Both pairs use the `small` scenario by default. To use a different scenario or explore flags:

```bash
# Underlying CLI: explicit scenario, custom output file, gate mode, or baseline regeneration
bun eval/perf/run.ts --scenario small --out my-report.json
bun eval/perf/run.ts --scenario medium --gate
bun eval/perf/run.ts --scenario vault1k --samples 5 --gate
bun eval/perf/run.ts --scenario large --samples 5 --update-baseline
```

## Isolation & Statistics (THE-503)

**The incident that motivated this:** a perf run once overlapped the Vitest suite. Index/embedding throughput read ~51% below baseline and dispatch p99 was 16ms vs an isolated 1ms — and **the gate still passed**, because latency/throughput are warn-only and nothing was watching for the contention itself.

`--samples N` (default 5, what `perf:*:isolated` use) switches to the isolated path (`sample.ts` + `isolate.ts` + `contention.ts`):

1. **Fresh subprocess per sample.** Each of the N samples is a genuinely separate `bun eval/perf/run.ts` process — no shared module cache, event loop, JIT state, or GC pressure with the harness's own runtime or with each other.
2. **Gate on the median, never a single observation.** `isolate.ts`'s `aggregate()` computes the median across all N samples per metric; the gate compares the median against the baseline.
3. **Coefficient of variation (CV) is tracked and reported** for every metric, alongside the full raw series — the artifact (`--out`) preserves every raw sample, not just the aggregate.
4. **Host-contention detection** (`contention.ts`): each subprocess runs two fixed, scenario-independent calibration probes alongside the real scenario — a **CPU** busy-loop and an **I/O** write+`fsync` loop (THE-584). Both are judged, and a recording is only trustworthy when **every channel** is quiet.
   - **Relative** (CV / max-over-median), per channel: catches *intermittent* contention (comes and goes between samples, or stalls one sample hard). Needs no external reference.
   - **Absolute** (vs a committed `eval/perf/calibration-reference.json`), per channel: catches *sustained, uniform* contention that the relative checks miss — the interfering load runs for the WHOLE measurement, slowing every sample by roughly the same amount (low CV, still wrong). Found empirically for both channels, not hypothesized: a constant 4-core CPU load produced `cv=0.159` ("clean") at roughly double a quiet median, and three concurrent `fsync` writers moved the I/O probe **43ms → 498ms (11.5×) while its CV went DOWN**, from 0.123 to 0.105.
   - **Why two channels.** The detector was CPU-only until THE-584. Two independent CI recordings then came back 40–90% worse on every warn metric while it printed `contention: clean (median 15.39ms, cv 0.056)` against a 15.37ms reference — CPU genuinely was fine, and everything that moved was I/O-shaped (SQLite writes, freshness, HTTP handshake). A recording accepted there ratchets ~14 warn thresholds looser in one commit. **This check is no longer CPU-only; it is CPU + I/O, and it is still not "any contention" — a channel nobody probes is a channel nobody detects.**
   - **Thresholds are per channel.** I/O is intrinsically noisier: a *quiet* host measured `cv` up to 0.229 and max/median up to 1.46, so it gets `cv 0.45 / max-median 2.5 / reference-tol 1.0` against CPU's `0.20 / 1.6 / 0.5`. Reusing the CPU numbers would refuse clean recordings, and a detector that cries wolf gets ignored.
   - **An unmeasured channel counts as dirty, never clean.** An all-zero calibration series passes every relative check (`cv` 0, max/median 1) and would read as the quietest host imaginable. It means the probe never ran, and it is reported as contention.
   - **Baselines are refused, not silently recorded, under detected contention.** `--update-baseline` in isolated mode exits 1 and leaves the existing baseline file untouched if any channel is contended. A plain `--gate` run still completes (CI must run regardless of transient noise) but prints a `WARN host contention detected` line. Both print the full **calibration vector** (`cpu … , io …`) so a reviewer can see *which* dimension was clean, and the baseline provenance sidecar records it so a past baseline can be re-judged later.
5. **Uniform workload shift** (`uniform-shift.ts`) — the probe-free comparability check, and the only one that cannot be blind to a channel nobody thought of. Every check above depends on someone having chosen a resource to probe; this one reads the **workload** instead.

   The rule: if most warn-class metrics moved in the **worse** direction together while **every hard-class count is unchanged**, the code did not change — the host did. The hard-class half is what makes it sound rather than merely suggestive. Hard metrics are seed-deterministic counts and ratios that cannot move because a machine got slower; a genuine code change that slowed things down almost always moves at least one of them. "Everything slower, nothing counted differently" is close to a signature.

   Calibrated against the incident that motivated the I/O channel, not invented: six comparable metrics all 1.5x-2x worse with zero hard-class movement. Defaults are **1.25x on at least 60% of comparable metrics**, with a floor of 4 comparable metrics (below that, "most moved" is not a claim). `exact` metrics are excluded — they have no worse direction.

   **A uniform IMPROVEMENT is not suspect.** Refusing to record a genuine win would be worse than the bug; `gate.ts`'s `STALE BASELINE` already covers the large-improvement case.

   Overridable with **`--accept-uniform-shift`**, which exists because PR #459 deliberately accepted exactly this shift — those numbers reproduced across runners while the old ones did not, so the new host *was* the reference. The override prints what it is accepting and how many thresholds it ratchets.
6. **Hard-class metrics must agree EXACTLY across all N samples**, independent of the baseline comparison. `isolate.ts`'s `checkHardStability()` treats any disagreement as its own hard failure (`HARD-UNSTABLE`, exit 1) — a "deterministic" invariant that varies across identically-seeded runs means the determinism assumption itself broke (real nondeterminism or a corrupted run), which is a different and more serious problem than a tolerance violation.
7. **CI concurrency**: the `perf` job in `ci-server.yml` carries its own (non-ref-scoped) `concurrency: group: perf-exclusive` so at most one `perf` job runs anywhere in the repo at a time.
8. **The I/O calibration probe's own scaling check** (THE-594): `contention.ts`'s `measureIoScalingRho()` samples `calibrateIo()` at ten round-counts and asserts a Spearman rank correlation (`spearman.ts`) between round-count and measured duration exceeds a calibrated threshold — proof that the probe measures real work rather than a constant. Gated on the **median rho across the N isolated samples** (`run.ts`'s `main()`), exactly like the contention channels above, not on any single observation. This assertion used to live in `test/perf-contention-io.test.ts`; see "Timing assertions belong here, not in `test/`" below for why it moved.

Recalibrating the quiet-host reference happens automatically as part of a successful (non-contended) `--update-baseline` run in isolated mode — it is committed and reviewed exactly like the metric baseline, for the same drift-safety reason (see "Baseline and Regeneration" below).

## Timing assertions belong here, not in `test/` (THE-594)

`packages/server/test/*.test.ts` runs on `ubuntu-latest`, `macos-latest` and `windows-latest`, on shared runners, with no isolation from whatever else vitest is running concurrently, and no host-contention detection. A wall-clock assertion placed there has to hold under all of that, every time, on three different OSes' scheduler and filesystem behavior. Twice on this exact metric (`calibrateIo()`'s scaling check, THE-584 → THE-594) a statistically-sound assertion was tuned, re-tuned, and still failed — first on macOS, then on `windows-latest` after the re-tune. The fix was never a better threshold; it was the wrong venue.

**The rule going forward:** if an assertion compares two real elapsed-time measurements (`performance.now()`/`Date.now()` diffs, or a function like `calibrateIo()` that measures wall time), it does not belong in `packages/server/test/`. It belongs here, under `eval/perf/`, where:

- `sample.ts` + `isolate.ts` already provide genuine subprocess isolation and gate on the **median of N samples**, never a single noisy observation;
- `contention.ts` detects host contention on the CPU and I/O channels and refuses to trust a contended recording;
- CI runs it on `ubuntu-latest` only, on a self-hosted-shaped runner, in its own `perf-exclusive` concurrency group — not fanned out across three OSes' worth of scheduler noise.

What is safe to keep in `test/`: assertions on **shape** (keys present, defined, correct `unit`/`class`/`direction`), **non-negativity** (`toBeGreaterThanOrEqual(0)` on a real duration is not host-sensitive — contention makes things slower, never negative), **bounded ratios** whose bounds are definitional rather than performance-derived (e.g. a recall/dedup ratio between 0 and 1), and **pure computations over synthetic/fixed data** (no real timing at all — see `test/perf-spearman.test.ts`). `scripts/check-perf-timing-scope.mjs` (wired into `ci-server.yml`'s `lint` job) enforces the narrowest, highest-confidence slice of this: it forbids importing the real-timing primitives (`calibrateIo`, `calibrate`, `measureIoScalingRho`) from `packages/server/test/` outside a small, named allowlist, so a NEW magnitude comparison built on top of them cannot land back in the unit suite unnoticed. It is not a full static check for every way a wall-clock assertion could reappear (e.g. a brand-new `performance.now()` diff compared via a raw `toBeLessThan`) — that class is caught by review against this section, not by tooling.

## Scenarios

Deterministic scenarios, each with a fixed PRNG seed (0x5eed), parametrizing the synthetic vault. Chunk count is always `notes * 2` (one body-section chunk + one links-section chunk per note — see `harness.ts`).

| Scenario | Notes | Dup Groups | Link Fanout | Paragraphs | Chunks | CI-gated? | Measured single-shot wall time |
|---|---|---|---|---|---|---|---|
| `small` | 100 | 20 | 3 | 2 | 200 | **yes** (`baseline.small.json`) | ~4-12s |
| `vault1k` | 500 | 100 | 3 | 2 | 1,000 | no | ~10s |
| `medium` | 1000 | 200 | 4 | 3 | 2,000 | no | ~15s |
| `large` | 5000 | 1000 | 4 | 3 | 10,000 | no | ~2min |
| `vault100k` | 50,000 | 10,000 | 4 | 3 | 100,000 | no — `expensive: true`, deliberately excluded from every script | not run in this session (see below) |

Only `small` has a committed baseline and a CI gate today (`ci-server.yml`'s `perf` job). The others are available for manual/ad-hoc use (`bun eval/perf/run.ts --scenario <name> ...`) when a THE-467/THE-468 decision needs a specific scale point.

**THE-503 scope note on `vault100k`:** cost scales super-linearly with corpus size (10,000 chunks measured ~2m23s single-shot on the reference dev host during this work — see git history for the exact number), so a single `vault100k` run is expected to take on the order of tens of minutes, and the 5-sample isolated mode proportionally longer. It was **not executed** in this session for that reason (and because this host itself has ambient multi-tenant noise — see the contention section above, which would make the numbers untrustworthy anyway). The scenario is fully defined and usable; running it and capturing a baseline is left as deliberate follow-up work, ideally on a dedicated (not shared) host.

Each scenario:
- Uses the same seed (0x5eed), so results are **deterministic** across runs on the same codebase.
- Generates synthetic notes from a fixed word vocabulary and body pool (no random dates, no `Math.random()`).
- Reuses note bodies verbatim across duplicate groups to test embedding deduplication.
- Generates per-note distinct wikilinks to build a meaningful graph structure.

## What this harness does NOT cover (THE-503 audit finding)

~~Graph densification is not exercised at all.~~ **Closed by THE-581.** The `densify` scenario runs the pass (`densify: { tagEdges: true, knnEdges: true }`) and family 15 gates its cost — see "Densification (family 15)" below.

Still not covered: multi-vault contention, concurrent indexing+retrieval, ACL-heavy over-fetch, sparse/ColBERT embedding scenarios, same-dimension model migration, scheduler-during-traffic, and failure injection (locked DB, slow provider, canceled shutdown) — see the THE-503 ticket for the full target list and the implementation notes for what was prioritized this pass.

### Densification (family 15, THE-581)

The `densify` scenario shares `small`'s corpus parameters EXACTLY (same seed, notes, dupGroups, linkFanout, paragraphs) and adds two things: deterministic frontmatter tags, and the `densify` option on `indexVault`. Sharing the corpus is what makes the comparison legible — any difference between the two scenarios is attributable to densification and nothing else. Tags live in frontmatter specifically because `parseNote` strips it before chunking, so chunk content, dedup groups, and embeddings stay byte-identical to `small`; only note-level tag metadata differs.

| metric | class | direction | why |
| -- | -- | -- | -- |
| `densify.vec_knn_calls` | hard | higher-worse | The cost driver. THE-486's "100x fewer chunks" and THE-533's reverse-neighbour bound are both expressed in outer per-chunk vec0 KNN calls; a call count is deterministic, so it gates without tolerance guesswork. `higher-worse` rather than `exact` so a future improvement registers as a win instead of tripping an invariant. |
| `densify.edges_similar_to` | hard | exact | The edge SET is correctness, not cost — building fewer edges is a different graph, not a faster one. |
| `densify.edges_shared_tag` | hard | exact | Same. |
| `densify.index_ms` | warn | higher-worse | Whole `indexVault` call with densification on, not densification alone (the indexer exposes no hook to time the pass by itself). The densification cost proper is this minus `small`'s index_ms. |

The collector **throws** rather than emitting zeros if a densify scenario produced no KNN calls or no edges. That is deliberate: a `hard`/`exact` zero matching a baseline zero reports PASS forever, which is precisely the failure mode this family exists to end — a gate that measures nothing while looking green.

**Demonstrated, not asserted.** Doubling the per-chunk `vecKnn` call in `computeKnnEdges` moved `densify.vec_knn_calls` 200 → 400 and the gate failed (`FAIL densify.vec_knn_calls: 400 vs baseline 200 (tol 0.15)`, exit 1); reverting returned it to 200 and exit 0.

**No baseline is committed yet.** Recording one needs a quiet host (the harness correctly refuses on a loaded one — calibration CV 0.822 against a 0.2 threshold), so it goes through the CI baseline workflow the same way `small`'s did. Until then the scenario runs on demand and is not part of the CI-gated set.

### Cold boot (family 16, THE-515)

Emitted for the **`small` scenario only**. Cold boot is scenario-independent — the probe never touches the vault — so measuring it in every baseline would copy identical numbers into several files and make one registration change demand several deliberate re-records for no added signal.

| metric | class | direction | why |
| -- | -- | -- | -- |
| `boot.tools_registered` | hard | exact | The only deterministic figure here, so it carries the gate. It also pins the module-registrar surface: adding a tool to a module moves it and demands a deliberate re-record. |
| `boot.module_eval_ms` | warn | higher-worse | Importing the tool surface cold. **The dominant term** — see below. |
| `boot.registration_ms` | warn | higher-worse | Running every `register*Tools`: ~148 tools and their Zod schemas. |
| `boot.tools_list_ms` | warn | higher-worse | First `tools/list`: visibility filtering **plus** the per-tool `toMcpTool` schema projection, which is what `mcp/server.ts` actually does. Timing `registry.list()` alone measured a map copy at 0.3 ms and would have stayed flat through a regression in the projection — the real path costs ~60 ms. Pagination and caller-context resolution are excluded: those need a live server, and this probe stands up no transport. |

`boot.tools_registered` is **148, not the 150** that `check-version-coherence` tracks. Two tools (`health`, `index_status`) are registered inline in `cli.ts` from live runtime state and cannot be built from a stub. 148 + 2 = 150.

**Why a subprocess.** `boot-probe.ts` runs as a fresh `bun` process, and this is mandatory rather than stylistic: by the time any collector runs, the harness has already imported the tool surface, so an in-process timing would report warm-module-cache numbers and understate the one term that dominates.

**Not collected under `--profile portable`.** That profile is the one path that runs `run.ts` **bundled** (`perf:node-parity` builds it to `eval/perf/.node-parity.mjs`), where the collector's `import.meta.url`-relative probe path does not resolve — and it discards `boot.*` anyway, since none of it is tagged `portable`. Skipping is both the fix and the honest behaviour: never pay for a subprocess whose output is thrown away.

**Registration is stubbed, and the stub throws.** Tool builders construct Zod schemas at build time and touch `deps` only inside handlers, so a stub pays the real registration cost without a vault, provider or database. The stub raises on *call*, verified against all eight registrars (148 tools still build) — a stub that quietly returned `undefined` would let a future builder do construction-time work for free and report a cheaper registration than production pays.

**Why this family exists.** THE-515 proposed lazy-initializing embeddings, ColBERT, the native module, sqlite-vec, graph analytics, the Dataview bridge and the scheduler, on the premise that startup pays for them. Measured 2026-07-26, it does not:

```
import mcp/registry (+transitive)   738.2 ms   <- 83% of cold start
import tools/m1 (+transitive)       101.0 ms
--- everything THE-515 proposed to lazy-init ---
createEmbeddingProvider (ollama)      0.4 ms
loadVec (sqlite-vec)                  2.1 ms
native binding load + first call      0.3 ms
new ToolRegistry({})                  0.2 ms
db open + migrations                 10.5 ms
```

~13 ms combined, against ~290 ms of module load for the bundled artifact (`dist/index.js`; ~560 ms from TS source). Nothing in the harness could have said so: `http.cold_ms` measures the per-request pipeline against an **empty** registry, and `migration.ms` covers only schema setup. This family is the missing description, so the next cold-start proposal is argued from a number instead of an intuition.

The collector **throws** if the probe registered no tools or returned a non-positive duration — a probe that measured nothing would otherwise report excellent timings, the same measures-nothing-while-green failure family 15 refuses.

## Gate Model: Hard vs. Warn

Metrics are classified into two enforcement levels:

### Hard Invariants (class: hard)
- **Deterministic counts** (chunk count, call counts, graph candidate cardinality, etc.) must not change.
- **Core quality metrics** (recall, nDCG, storage bytes, memory ratio) are hard gated to catch regressions.
- **Violations fail CI** — a hard regression cannot land.
- Specified with `direction: "exact"` (exact count, zero tolerance) or `direction: "lower-worse" | "higher-worse"` (quality thresholds, ±15% tolerance).

### Warn Invariants (class: warn)
- **Noisy latency figures** (throughput, dispatch overhead, eventloop delay, shutdown drain, etc.) that vary across shared CI runners.
- **Violations emit warnings only**, never fail CI.
- Specified with ±50% or ±25% tolerance (per metric type).

**One-sided directionality:** Improvements (better than baseline) never trigger a violation. Only regressions (worse than baseline, exceeding tolerance) do.

## Why Bun-Only

The harness runs **under bun**, not node, because:

- **sqlite-vec is the blocker**: The real ANN search path uses `sqlite-vec` for dense-vector similarity queries.
- `bun` + `better-sqlite3` load sqlite-vec correctly.
- `node` + `sqlite` (the Node.js built-in) does NOT load sqlite-vec; queries that depend on it fail.
- This means `migration.rebuilt` (vec-index rebuild metric) and `graph.candidates_*` (ANN-based graph traversal counts) only work under bun.

### Node portability run (THE-494)

There **is** a Node run now, and it is deliberately not a second perf gate:

```bash
bun run perf:node-parity     # bundles the harness for node, then runs it under node
```

It bundles `run.ts` with `bun build --target node` (Node cannot resolve the harness's extensionless
TypeScript imports directly) and executes `--profile portable` under `node`. That profile reports
**only** the metrics tagged `portable: true` at their source — deterministic and storage-agnostic,
so they mean the same thing with or without sqlite-vec — and the runner **refuses** `--gate` and
`--update-baseline` under it. Two runtimes, two meanings, never one baseline.

The tag is **opt-in**: a new metric is non-portable until someone says so. Forgetting it
under-reports by one metric (visible, harmless); the inverse default would silently benchmark a
brute-force fallback and call it parity. The set is enumerated, floored and reasoned in
`test/perf-node-parity.test.ts`, and a profile that selects zero metrics exits non-zero rather than
reporting a clean portability result over an empty set.

Excluded on purpose: everything vec/ANN-dependent (`graph.candidates_*`, `retrieval.*`),
`storage.bytes` (the vec virtual tables do not exist under Node, so the file is a different size by
construction), and the runtime-characteristic metrics (`runtime.*`, `dispatch.*`, `http.*`).

Measured 2026-07-25 on the `small` scenario — every **hard-class** metric is identical across
runtimes, which is exactly the signal this run exists to produce:

| metric | class | bun 1.3.14 | node 26.5.0 |
| --- | --- | --- | --- |
| `index.chunk_count` | hard | 200 | 200 |
| `index.txn_count` | hard | 3 | 3 |
| `embed.call_count` | hard | 2 | 2 |
| `embed.dup_ratio` | hard | 0.4 | 0.4 |
| `freshness.visible` | hard | 1 | 1 |
| `index.chunks_per_s` | warn | 861.8 | 437.5 |
| `embed.texts_per_s` | warn | 517.1 | 262.5 |
| `freshness.ms` | warn | 214.0 | 139.8 |

The warn-class rows differ by runtime and are **not** a cross-runtime latency claim — note that
`freshness.ms` is *lower* under node while throughput is *higher* under bun. Informational only.

CI runs it as a `continue-on-error` **step** (not a job-level setting, which does not survive a
failed step — every later step would be skipped, silently dropping the artifact upload) and
publishes `perf-node-parity.json`.

## Determinism

Two mechanisms ensure results are byte-identical across runs:

1. **Seeded PRNG (Mulberry32):** Vault corpus generation uses a fixed seed (0x5eed), not `Date.now()` or `Math.random()`.
   - Same seed → identical note bodies, links, and structure.
   - Each scenario fixes its seed; results are stable across runtimes.

2. **Fake embedding provider:** The harness uses a deterministic embedding provider (hardcoded vectors derived from query text, not a real model).
   - Embedding calls always return the same vectors for the same text.
   - No network, no model inference, no variance.

3. **Total ordering on ranked results (THE-582):** `vecKnn` and `semanticSearch` break exact distance/score ties by `chunk_id`, so equal-scoring candidates rank in a fixed order rather than in whatever order the vec0 scan or the table scan produced.
   - Ties are the common case here, not a corner case: `dupGroups=20` over `notes=100` means five notes share a byte-identical body, embed to identical vectors, and tie exactly. In the `small` corpus the rank-10 distance spans the top-10 cut on 3 of 5 labelled queries, so the tie order decides top-10 **membership**.
   - vec0 will not do this in SQL — it rejects a second sort key (`Only a single 'ORDER BY distance' clause is allowed on vec0 KNN queries`) — so the tiebreak is applied after the query returns, and is pinned by `bun-smoke/vec-tie-order.test.ts`.

**Result:** Deterministic invariants (families 3, 4, 5, 7, 8, 9, 11, 13, 14 — counts, ratios, recall/nDCG, storage bytes, booleans) are identical **run-to-run on a given host**. Latency figures (families 1, 2, 6, 10 and the `*_ms` sub-metrics) vary naturally and are gated warn-only. Family 12 (HTTP handshake) is deferred (THE-495) and not emitted.

### Run-to-run is not the same claim as host-to-host

Read the sentence above precisely: it says *run-to-run*. Until THE-582 that distinction was not made, and the wording invited reading it as "identical everywhere" — the reading under which a legitimate cross-host difference looks like a regression.

The difference was real. On commit `8a99e39`, same seeded corpus, same scenario:

| metric | Cave (aarch64) | CI runner (x86_64) |
| -- | -- | -- |
| `retrieval.ndcg_at10` | 0.80281468033933 | 0.8414330514255118 |
| `retrieval.recall_at10` | 0.96 | 0.96 |
| `graph.candidates_{seed,expand,fused}` | 30 / 80 / 85 | 30 / 80 / 85 |

Each host was internally perfect (`cv 0.000` across 5 fresh-subprocess samples) and they disagreed with each other. The shape identifies the cause: `recall_at10` is **set**-based and matched, `ndcg_at10` is **order**-based and did not, and the counts matched — the same documents in a different order. Mechanism 3 above is the fix; the metric should now be host-independent, which is what `bun-smoke/vec-tie-order.test.ts` asserts on the x86_64 runner.

Genuinely host-independent, demonstrated by matching exactly across both architectures before the fix: `retrieval.recall_at10` and every count family. `retrieval.ndcg_at10` joined them only once ties were totally ordered — a metric that reads ORDER is only as host-independent as its tiebreak.

## Baseline and Regeneration

The baseline lives in `eval/perf/baseline.${scenario}.json`, e.g., `eval/perf/baseline.small.json` for the small scenario. Each metric entry has:

```json
{
  "key": {
    "value": 123,         // baseline measurement
    "tol": 0.15,          // absolute (abs) or relative (ratio) tolerance
    "mode": "ratio",      // "abs" for counts/ratios, "ratio" for per-second metrics
    "class": "hard",      // "hard" (fails CI) or "warn" (informational)
    "direction": "exact"  // "exact", "lower-worse", or "higher-worse"
  }
}
```

### Intentional Regeneration

To regenerate the baseline after an intentional change (e.g., optimization that reduces latency), run:

```bash
bun eval/perf/run.ts --scenario small --update-baseline
```

This:
1. Runs the scenario.
2. Writes a new `eval/perf/baseline.small.json` with fresh measurements.
3. Prints the report to stdout.

**Important:** Baseline changes must be **manually committed** and **justified in the PR**. The baseline is drift-safe because you hand-commit it, not because it auto-updates. Include a rationale in your commit message explaining why the baseline shifted (e.g., "optimize graph traversal → 5% faster nDCG/ms").

**THE-503:** in isolated mode (`--samples N --update-baseline`), the same file is written from the **median** across N fresh-subprocess samples, and the run is **refused outright (exit 1, file untouched)** if host contention was detected during sampling — see "Isolation & Statistics" above. `eval/perf/calibration-reference.json` (the committed "quiet host" calibration median used for sustained-contention detection) is written alongside it, under the same refusal discipline, and should be regenerated whenever the reference CI hardware changes materially.

### The reference host is the CI runner (THE-534)

**Do not record a baseline on a developer machine.** The reference is the machine the gate compares on: `ubuntu-latest`, via the `perf-baseline` workflow (`workflow_dispatch` → pick a scenario → it opens a PR with the recorded files).

This is a decision, not a convenience. A baseline is only meaningful if it was measured somewhere reproducible, and a dev box generally is not: the host this project is built on sits at load ~7 across 4 cores with 43 containers, where the harness correctly **refuses** to record (calibration CV 0.822 against a 0.2 threshold). The options were to weaken the refusal or to move the reference; the refusal is the feature, so the reference moved.

Three properties are deliberate:

- **It opens a PR, it does not push.** Recording moves to CI; *review* does not. A self-updating baseline would ratchet in a regression one green run at a time — the exact failure THE-534 exists to prevent. Review the **direction** of every changed number: one that moved the worse way is a regression being accepted into the reference, and needs a reason in the PR.
- **`workflow_dispatch` only.** Re-baselining is a deliberate act taken when the system changed on purpose. On a schedule or on push it would quietly absorb drift.
- **It shares the gate's `perf-exclusive` concurrency group**, so a recording run can never be contended by a gate run on the same shared capacity.

A refused recording (contention detected) fails the job and opens no PR — so a PR existing is itself the evidence that contention was not detected.

**THE-534:** every baseline write also emits `eval/perf/baseline.<scenario>.provenance.json` recording the commit SHA it was measured against, whether the working tree was dirty at the time, the mode (`isolated-median` / `single-shot`), the sample count, and the host shape. A baseline measured on a dirty tree is **not reproducible from its SHA**, so that case prints a loud `WARN` — the SHA alone would be a false provenance claim. It is a **sidecar file, not a key inside the baseline**, because the gate now walks the baseline's own keys and demands a measurement for each; a metadata key living in that file would be read as a metric that is never measured, i.e. a permanent phantom failure.

## Gate coverage: what the gate can and cannot see (THE-534 audit)

The gate compares by walking the **baseline**, not the report. That inversion is load-bearing. The previous version iterated `report.samples` and looked the baseline up, which made it blind to anything the report failed to mention — and all three of these reported `perf gate OK`:

1. an **empty report** (harness produced nothing at all);
2. a **baselined metric that stopped being emitted**;
3. a **key renamed upstream**, carrying a 100× regression, landing in no baseline entry.

Now a baselined key with no sample is a violation of its own class (`reason: "missing"`), which is what gives the gate a non-empty floor. Samples present in the report but absent from the baseline stay informational — a new metric is not yet a promise; the renamed-key case is caught from the other side, because the old key goes missing.

**Large improvements are reported, never silently accepted.** An improvement never fails (blocking a good change would be worse than the bug), but one beyond 2× is listed as `STALE BASELINE`, because a baseline that no longer describes the system gets cited later in a go/no-go.

**What the gate still cannot see.** Re-read the "What this harness does NOT cover" section above before trusting a null result. Densification *was* the headline entry here — `buildVault()` called `indexVault()` without `densify` and no collector emitted a densification metric, which is why THE-486's 113× improvement passed CI without comment: there was never a number to compare, and no tolerance change could have produced one. THE-581 closed that with the `densify` scenario and family 15, so THE-533's write cost is now expressible as a gated number rather than a table in a PR body. Note the residual: the `densify` scenario has no committed baseline yet (it needs a quiet host), so until that lands the coverage exists but is not enforced in CI.

## Synthetic Labelled Set

For family 9 (recall/nDCG) metrics, the harness uses a small, **throwaway synthetic relevance set**. It:

- **Is NOT the private golden set** (see THE-421 leak class). No real vault data, no user queries, no secret information.
- **Is co-generated** with the seeded synthetic vault: queries + paths are deterministic artifacts of the corpus.
- **Is in-repo** and can be freely shared in PRs, GitHub, etc., without leak concerns.
- Uses sentinel tokens (`zqmarker${i}`) to distinguish body groups in queries (hard to confuse with other groups via the shared word vocabulary).

See `packages/server/eval/perf/labelled.ts` for the definition (5 queries, 20 relevant notes per query for small scenario).

## Metric Families

The harness collects all 14 THE-459 metric families across 7 collector modules, plus a THE-503 concurrent-HTTP addition.

| Family | Type | Metrics | Module | Class | Notes |
|---|---|---|---|---|---|
| 1 | Dispatch overhead | `dispatch.overhead_p{50,95,99}_ms` | dispatch.ts | warn | Measures the ToolRegistry pipeline cost in isolation |
| 2 | Freshness | `freshness.{visible, ms}` | dispatch.ts | {hard, warn} | Time from write to search-visible |
| 3 | Index throughput | `index.{chunk_count, chunks_per_s}` | indexing.ts | {hard, warn} | Indexing rate; count is deterministic |
| 4 | Embed throughput | `embed.{call_count, texts_per_s}` | indexing.ts | {hard, warn} | Embedding API usage; call count deterministic |
| 5 | Embed dedup ratio | `embed.dup_ratio` | indexing.ts | hard | Fraction of chunks sharing a body (exact deterministic) |
| 6 | Event-loop delay | `runtime.eventloop_p99_ms` | runtime.ts | warn | P99 event-loop delay under REAL concurrent load (THE-503: see below — this used to read 0 almost every run) |
| 7 | SQLite txn/lock + write-txn count | `storage.{txn_count, txn_ms}`, `index.txn_count` | storage.ts, indexing.ts | {hard, warn} | `storage.txn_count` is a synthetic fixed-size (200) scratch-table microbench timing raw commit overhead — NOT connected to indexVault. `index.txn_count` (THE-503, new) IS the real write-transaction count indexVault used (via a `db.exec("BEGIN")` counting wrapper), gated hard as "lower is better" (`direction: "higher-worse"`) rather than exact-match, so THE-500's batching can register as an improvement instead of tripping an invariant that could never recognize one. |
| 8 | Graph candidates | `graph.candidates_{seed, expand, fused}` | retrieval.ts | hard | ANN graph traversal stage cardinality (exact deterministic) |
| 9 | Recall/nDCG | `retrieval.{recall_at10, ndcg_at10, ndcg_per_ms}` | retrieval.ts | {hard, hard, warn} | Relevance metrics over synthetic labelled set |
| 10 | Peak memory | `runtime.peak_rss_mb` | runtime.ts | warn | Peak process RSS during the run, in MB. NOT normalized per chunk: RSS is whole-process, so a per-chunk figure attributes memory it cannot account for (THE-459). Scenarios are fixed-size, so absolute RSS is comparable run-to-run. |
| 11 | Vec migration | `migration.{rebuilt, ms}` | lifecycle.ts | {hard, warn} | Vec-index rebuild latency; rebuilt = bun-only true |
| 12 | HTTP handshake | `http.handshake_ok`, `http.cold_ms`, `http.warm_ms` | http.ts | hard / warn | MCP `initialize` round-trip through the real Hono app via `app.fetch()` — **no network listener is bound**. Cold vs warm separates one-time init from steady-state per-request cost (the build THE-463 proposes caching). `handshake_ok` requires a protocol-level `result`, so a degraded handshake fails rather than passing on a 200. |
| 12b | Concurrent HTTP callers (THE-503) | `http.concurrent{2,8}_{ok_count,p99_ms}` | http.ts | {hard, warn} | 2 and 8 concurrent `initialize` calls fired via `Promise.all` over `app.fetch()` (still no network listener). `ok_count` must equal the concurrency level (hard) — a degraded/racy handshake under load fails rather than passing silently. |
| 13 | Shutdown drain | `shutdown.{drained, ms}` | lifecycle.ts | {hard, warn} | Graceful DB close under deadline; runs last |
| 14 | Per-vault storage | `storage.{bytes, cpu_ms}` | storage.ts | {hard, warn} | DB page bytes (exact); CPU over the txn batch |

**Collector execution order** (in `run.ts`):
1. indexing (families 3, 4, 5, 7's `index.txn_count`)
2. retrieval (families 8, 9)
3. dispatch (families 1, 2)
4. storage (families 7's `storage.*`, 14)
5. runtime (families 6, 10)
6. http (family 12, then 12b) — needs a live db
7. lifecycle (families 11, 13) — **closes vault.db, must run last**

### THE-503: event-loop delay used to silently read 0

`runtime.eventloop_p99_ms` used to read 0 on almost every run. Root cause, confirmed empirically: the old load loop `await`ed one `graphSearch` call at a time. Each call resolves through nothing but microtasks, and microtasks always drain completely before the event loop returns to its poll phase — so control never crossed a macrotask boundary while the load ran, and `monitorEventLoopDelay`'s internal check (driven off that boundary) recorded **zero samples at all** (`h.count === 0`), not "delay below resolution". A histogram with no samples reports 0 from `.percentile()`, silently indistinguishable from "no delay".

Fixed per the ticket's own two remedies, applied together: resolution dropped to 1ms (the minimum `monitorEventLoopDelay` accepts), and the load loop now runs concurrent batches (4 at a time, 20 batches) with an explicit `setImmediate` yield between batches — a genuine macrotask boundary the monitor can sample at, run long enough to accumulate a non-degenerate distribution. Verified non-zero under both Node (vitest) and real bun.

## Interpreting Results

### Success (no output)
```bash
$ bun run perf:gate
perf gate OK (0 warnings)
```

### Warnings (latency variance, does not fail CI)
```bash
$ bun run perf:gate
WARN dispatch.overhead_p95_ms: 1.5 vs baseline 1
WARN runtime.eventloop_p99_ms: 0.5 vs baseline 0
perf gate OK (2 warnings)
```

### Hard failure (blocks merge)
```bash
$ bun run perf:gate
FAIL retrieval.recall_at10: 0.85 vs baseline 0.96 (tol 0.15)
exit code 1
```

A hard failure means a deterministic invariant (chunk counts, call counts, recall thresholds) has regressed and **must be fixed before landing**.

## Testing

Harness self-tests verify:
- Determinism: running the same scenario twice produces identical counts.
- Gate logic: violations are correctly classified as hard/warn (`test/perf-gate.test.ts`).
- Baseline format: entries are parsed correctly.
- THE-503: aggregation (median/CV/raw preservation, `test/perf-isolate.test.ts`), contention
  detection (`test/perf-contention.test.ts`), subprocess orchestration against a fake spawn
  (`test/perf-sample.test.ts`), and a REAL end-to-end subprocess-isolation run
  (`test/perf-isolate-integration.test.ts` — actually spawns 2 fresh `bun` processes; slower by
  design, this is what proves isolation rather than asserting it).
- THE-594: the Spearman rank-correlation statistic behind the I/O calibration probe's scaling
  check is proven to have power — including rejecting a constant-duration stub — with no real
  timing at all (`test/perf-spearman.test.ts`). The check itself (real `calibrateIo()`
  measurements, gated on the median across N isolated samples) runs as part of this harness, not
  the unit suite — see "Timing assertions belong here, not in `test/`" above.

Run via:
```bash
bun run test
```

(Harness tests live in `test/perf-*.test.ts`; `test/perf-run.test.ts` imports `runScenario` from this module.)

## References

- Task brief: [THE-459 issue](https://linear.app/the-40-thieves/issue/THE-459), [THE-503 issue](https://linear.app/the-40-thieves/issue/THE-503) (isolation + statistics + scenario coverage)
- Private golden set (THE-421 leak class): see `/data/llm-stack/obsidian-tc-eval/` on Cave.
- Node.js parity: [THE-494 issue](https://linear.app/the-40-thieves/issue/THE-494)
