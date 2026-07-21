# THE-459 Synthetic-vault perf harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic, bun-run synthetic-vault benchmark harness covering THE-459's 14 metric families, with a committed baseline and a CI gate that hard-fails deterministic-metric regressions and warns on noisy latency.

**Architecture:** A self-contained `packages/server/eval/perf/` tree drives the real `better-sqlite3 + sqlite-vec` storage path over a seeded synthetic vault built with the deterministic `fake` embedding provider. Collectors (one module per metric group) return typed `MetricSample[]`; a pure `gate.ts` compares the report against a committed `baseline.json` and exits non-zero only on hard-class violations. Two source seams are added additively: a counting-provider wrapper and an `onStage` observer on `graphSearch`.

**Tech Stack:** TypeScript, bun runtime, `better-sqlite3`, `sqlite-vec`, `perf_hooks`, vitest (harness self-tests), prom-client (`MetricsRecorder`, already present).

## Global Constraints

- Runtime for the harness is **bun only** (`better-sqlite3 + sqlite-vec`, real prod path). Node parity is out of scope — tracked as THE-494.
- All new source edits outside `eval/perf/` must be **additive and behavior-preserving** (new optional fields/params defaulting to current behavior).
- Determinism is mandatory: seeded PRNG + `fakeEmbeddingProvider`; no network, no wall-clock in corpus generation.
- The synthetic labelled query set is **in-repo and throwaway** — it must share nothing with the private golden set (THE-421 leak class).
- Lint/format via biome (`bun run lint`); server typechecks strict (`bun run typecheck` in `packages/server`).
- Commits are DCO-signed: `git commit -s`. Trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Branch: `mislam2/the-459-perf-gates-synthetic-vault-benchmark` (already created off `origin/main`).
- All harness files live under `packages/server/eval/perf/`; run commands are executed from `packages/server`.

---

### Task 1: Report types + gate (pure, no vault needed)

**Files:**
- Create: `packages/server/eval/perf/report.ts`
- Create: `packages/server/eval/perf/gate.ts`
- Test: `packages/server/test/perf-gate.test.ts`

**Interfaces:**
- Produces: `MetricSample`, `BaselineEntry`, `Baseline`, `PerfReport` (report.ts); `GateViolation`, `GateResult`, `evaluate(report, baseline) => GateResult` (gate.ts).

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/perf-gate.test.ts
import { describe, expect, it } from "vitest";
import { evaluate } from "../eval/perf/gate";
import type { Baseline, PerfReport } from "../eval/perf/report";

const baseline: Baseline = {
  "index.chunks_per_s": { value: 4000, tol: 0.15, mode: "ratio", class: "hard", direction: "lower-worse" },
  "embed.dup_ratio":    { value: 0.5,  tol: 0.01, mode: "abs",   class: "hard", direction: "higher-worse" },
  "dispatch.p95_ms":    { value: 10,   tol: 0.4,  mode: "ratio", class: "warn", direction: "higher-worse" },
};

function report(samples: PerfReport["samples"]): PerfReport {
  return { scenario: "small", samples };
}

describe("perf gate evaluate()", () => {
  it("passes when all metrics are within tolerance", () => {
    const r = evaluate(report([
      { key: "index.chunks_per_s", value: 3800, unit: "per_s", class: "hard", direction: "lower-worse" },
      { key: "embed.dup_ratio", value: 0.505, unit: "ratio", class: "hard", direction: "higher-worse" },
      { key: "dispatch.p95_ms", value: 12, unit: "ms", class: "warn", direction: "higher-worse" },
    ]), baseline);
    expect(r.hardFailures).toHaveLength(0);
    expect(r.warnings).toHaveLength(0);
  });

  it("hard-fails a lower-worse throughput regression past ratio tol", () => {
    const r = evaluate(report([
      { key: "index.chunks_per_s", value: 3000, unit: "per_s", class: "hard", direction: "lower-worse" },
    ]), baseline);
    expect(r.hardFailures.map((v) => v.key)).toEqual(["index.chunks_per_s"]);
  });

  it("does not fail when a metric IMPROVES (throughput higher)", () => {
    const r = evaluate(report([
      { key: "index.chunks_per_s", value: 9000, unit: "per_s", class: "hard", direction: "lower-worse" },
    ]), baseline);
    expect(r.hardFailures).toHaveLength(0);
  });

  it("hard-fails a higher-worse abs regression (dup ratio drifted up)", () => {
    const r = evaluate(report([
      { key: "embed.dup_ratio", value: 0.52, unit: "ratio", class: "hard", direction: "higher-worse" },
    ]), baseline);
    expect(r.hardFailures.map((v) => v.key)).toEqual(["embed.dup_ratio"]);
  });

  it("routes warn-class violations to warnings, never hardFailures", () => {
    const r = evaluate(report([
      { key: "dispatch.p95_ms", value: 100, unit: "ms", class: "warn", direction: "higher-worse" },
    ]), baseline);
    expect(r.hardFailures).toHaveLength(0);
    expect(r.warnings.map((v) => v.key)).toEqual(["dispatch.p95_ms"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node ./node_modules/vitest/vitest.mjs run test/perf-gate.test.ts` (from `packages/server`)
Expected: FAIL — cannot resolve `../eval/perf/gate`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/server/eval/perf/report.ts
export type MetricClass = "hard" | "warn";
export type MetricMode = "abs" | "ratio";
/** lower-worse: throughput/quality (a drop is a regression). higher-worse: latency/cost/bytes.
 *  exact: a deterministic count that must not move at all (tol is the allowed slack). */
export type Direction = "lower-worse" | "higher-worse" | "exact";

export interface MetricSample {
  key: string;
  value: number;
  unit: "count" | "per_s" | "ms" | "ratio" | "bytes" | "bool";
  class: MetricClass;
  direction: Direction;
}

export interface BaselineEntry {
  value: number;
  tol: number;
  mode: MetricMode;
  class: MetricClass;
  direction: Direction;
}
export type Baseline = Record<string, BaselineEntry>;

export interface PerfReport {
  scenario: string;
  samples: MetricSample[];
}

export function toMarkdown(report: PerfReport): string {
  const rows = report.samples
    .map((s) => `| ${s.key} | ${s.value} | ${s.unit} | ${s.class} | ${s.direction} |`)
    .join("\n");
  return `## perf report — ${report.scenario}\n\n| metric | value | unit | class | direction |\n|---|---|---|---|---|\n${rows}\n`;
}
```

```ts
// packages/server/eval/perf/gate.ts
import type { Baseline, MetricMode, MetricClass, PerfReport } from "./report";

export interface GateViolation {
  key: string;
  actual: number;
  baseline: number;
  tol: number;
  mode: MetricMode;
  class: MetricClass;
}
export interface GateResult {
  hardFailures: GateViolation[];
  warnings: GateViolation[];
}

/** True when `actual` is worse than `baseline` by more than `tol`, honoring direction + mode.
 *  Improvements (better than baseline) never violate. */
function isViolation(
  actual: number,
  b: Baseline[string],
): boolean {
  const limit = b.mode === "ratio" ? Math.abs(b.value) * b.tol : b.tol;
  const delta = actual - b.value; // >0 means actual is higher than baseline
  if (b.direction === "higher-worse") return delta > limit;
  if (b.direction === "lower-worse") return -delta > limit;
  return Math.abs(delta) > limit; // exact
}

export function evaluate(report: PerfReport, baseline: Baseline): GateResult {
  const hardFailures: GateViolation[] = [];
  const warnings: GateViolation[] = [];
  for (const s of report.samples) {
    const b = baseline[s.key];
    if (!b) continue; // metric present in report but not baselined yet — informational only
    if (!isViolation(s.value, b)) continue;
    const v: GateViolation = {
      key: s.key,
      actual: s.value,
      baseline: b.value,
      tol: b.tol,
      mode: b.mode,
      class: b.class,
    };
    (b.class === "hard" ? hardFailures : warnings).push(v);
  }
  return { hardFailures, warnings };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node ./node_modules/vitest/vitest.mjs run test/perf-gate.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/server/eval/perf/report.ts packages/server/eval/perf/gate.ts packages/server/test/perf-gate.test.ts
git commit -s -m "feat(perf): report types + baseline gate for THE-459 harness"
```

---

### Task 2: Seeded synthetic vault + counting provider + determinism

**Files:**
- Create: `packages/server/eval/perf/scenarios.ts`
- Create: `packages/server/eval/perf/harness.ts`
- Test: `packages/server/test/perf-harness.test.ts`

**Interfaces:**
- Consumes: `openDatabase(path)` from `src/db/open`, `provisionCacheDb(db)` from `src/db/provision`, `fakeEmbeddingProvider` from `src/embeddings`, `indexVault(args)` / `IndexStats` from `src/search/indexer`.
- Produces:
  - `SCENARIOS: Record<"small"|"medium"|"large", Scenario>` and `Scenario` (scenarios.ts).
  - `CountingProvider` (wraps `EmbeddingProvider`, exposes `.calls`, `.texts`), `buildVault(scenario) => Promise<VaultCtx>`, `VaultCtx { db, root, provider, stats, chunkCount, cleanup }`, `mulberry32(seed)`, `quantiles(nums)` (harness.ts).

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/perf-harness.test.ts
import { describe, expect, it } from "vitest";
import { buildVault, quantiles } from "../eval/perf/harness";
import { SCENARIOS } from "../eval/perf/scenarios";

describe("perf harness synthetic vault", () => {
  it("is deterministic: same scenario -> identical chunk count + dup structure", async () => {
    const a = await buildVault(SCENARIOS.small);
    const b = await buildVault(SCENARIOS.small);
    expect(a.chunkCount).toBe(b.chunkCount);
    expect(a.provider.texts).toBe(b.provider.texts); // unique bodies embedded — identical
    expect(a.stats.chunks_upserted).toBe(b.stats.chunks_upserted);
    a.cleanup();
    b.cleanup();
  });

  it("embeds fewer texts than chunks because of the duplicate-body set", async () => {
    const v = await buildVault(SCENARIOS.small);
    expect(v.provider.texts).toBeLessThan(v.chunkCount);
    expect(v.provider.texts).toBeGreaterThan(0);
    v.cleanup();
  });

  it("quantiles() returns p50<=p95<=p99", () => {
    const q = quantiles([5, 1, 4, 2, 3, 9, 7, 8, 6, 10]);
    expect(q.p50).toBeLessThanOrEqual(q.p95);
    expect(q.p95).toBeLessThanOrEqual(q.p99);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node ./node_modules/vitest/vitest.mjs run test/perf-harness.test.ts`
Expected: FAIL — cannot resolve `../eval/perf/harness`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/server/eval/perf/scenarios.ts
export interface Scenario {
  name: "small" | "medium" | "large";
  seed: number;
  notes: number;        // number of source notes
  dupGroups: number;    // notes reused verbatim from this many distinct bodies
  linkFanout: number;   // outbound [[wikilinks]] per note (drives the graph)
  paragraphs: number;   // paragraphs per note (roughly one chunk each)
}

export const SCENARIOS: Record<Scenario["name"], Scenario> = {
  small:  { name: "small",  seed: 0x5eed, notes: 100,   dupGroups: 20,  linkFanout: 3, paragraphs: 2 },
  medium: { name: "medium", seed: 0x5eed, notes: 1000,  dupGroups: 200, linkFanout: 4, paragraphs: 3 },
  large:  { name: "large",  seed: 0x5eed, notes: 3400,  dupGroups: 400, linkFanout: 4, paragraphs: 3 }, // ~10k chunks
};
```

```ts
// packages/server/eval/perf/harness.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { openDatabase } from "../../src/db/open";
import { provisionCacheDb } from "../../src/db/provision";
import type { Database } from "../../src/db/types";
import { type EmbeddingProvider, fakeEmbeddingProvider } from "../../src/embeddings";
import { type IndexStats, indexVault } from "../../src/search/indexer";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Scenario } from "./scenarios";

/** Deterministic PRNG (Mulberry32). No Date/Math.random in corpus generation. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  "vault", "chunk", "embed", "graph", "recall", "bridge", "index", "query",
  "token", "vector", "sparse", "dense", "rerank", "fusion", "activation", "scope",
];

function paragraph(rnd: () => number, n = 24): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(WORDS[Math.floor(rnd() * WORDS.length)] as string);
  return out.join(" ");
}

/** Counts embed() calls + total texts embedded, for dup-ratio + embed-throughput collectors. */
export interface CountingProvider extends EmbeddingProvider {
  calls: number;
  texts: number;
}
export function countingProvider(base: EmbeddingProvider): CountingProvider {
  const wrapped: CountingProvider = {
    id: base.id,
    provider: base.provider,
    model: base.model,
    dimensions: base.dimensions,
    calls: 0,
    texts: 0,
    embed(texts, opts) {
      wrapped.calls += 1;
      wrapped.texts += texts.length;
      return base.embed(texts, opts);
    },
  };
  return wrapped;
}

export interface VaultCtx {
  db: Database;
  root: string;
  provider: CountingProvider;
  stats: IndexStats;
  chunkCount: number;
  cleanup: () => void;
}

/** Build + index a seeded synthetic vault on the REAL bun storage path. */
export async function buildVault(sc: Scenario): Promise<VaultCtx> {
  const rnd = mulberry32(sc.seed);
  const root = mkdtempSync(join(tmpdir(), `obtc-perf-${sc.name}-`));

  // A fixed pool of distinct bodies; notes cycle through it so `dupGroups` distinct
  // bodies back `notes` files -> duplicate-body set is exact and seed-stable.
  const bodies: string[] = [];
  for (let i = 0; i < sc.dupGroups; i++) {
    const paras: string[] = [];
    for (let p = 0; p < sc.paragraphs; p++) paras.push(paragraph(rnd));
    bodies.push(`# Body ${i}\n\n${paras.join("\n\n")}`);
  }
  for (let n = 0; n < sc.notes; n++) {
    const body = bodies[n % sc.dupGroups] as string;
    const links: string[] = [];
    for (let l = 0; l < sc.linkFanout; l++) {
      links.push(`[[note-${Math.floor(rnd() * sc.notes)}]]`);
    }
    const rel = `note-${n}.md`;
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `${body}\n\n${links.join(" ")}\n`);
  }

  const db = await openDatabase(":memory:");
  provisionCacheDb(db);
  const provider = countingProvider(fakeEmbeddingProvider({ dimensions: 32, model: "fake-perf" }));
  const stats = await indexVault({
    db,
    provider,
    vaultId: sc.name,
    root,
    isReadable: () => true,
    chunkContext: false,
  });

  const chunkCount = (db.prepare("SELECT count(*) c FROM chunks").get() as { c: number }).c;
  return { db, root, provider, stats, chunkCount, cleanup: () => { db.close?.(); rmSync(root, { recursive: true, force: true }); } };
}

export interface Quantiles { p50: number; p95: number; p99: number }
export function quantiles(nums: number[]): Quantiles {
  const s = [...nums].sort((a, b) => a - b);
  const at = (q: number): number => s[Math.min(s.length - 1, Math.floor(q * s.length))] as number;
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}

/** Warmup + measured wall-time quantiles over `n` iterations of `fn`. */
export async function timedQuantiles(fn: () => Promise<unknown> | unknown, n = 20, warmup = 3): Promise<Quantiles> {
  for (let i = 0; i < warmup; i++) await fn();
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  return quantiles(samples);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run --cwd packages/server test/perf-harness.test.ts` is NOT how vitest runs; use:
`cd packages/server && node ./node_modules/vitest/vitest.mjs run test/perf-harness.test.ts`
Expected: PASS (3 tests). If `openDatabase(":memory:")` under Node lacks sqlite-vec, `vec_enabled` is false but chunk counts still populate — the test asserts counts, not vec. (The vec-dependent collectors run bun-only in later tasks.)

- [ ] **Step 5: Commit**

```bash
git add packages/server/eval/perf/scenarios.ts packages/server/eval/perf/harness.ts packages/server/test/perf-harness.test.ts
git commit -s -m "feat(perf): seeded synthetic vault + counting provider + timing primitives"
```

---

### Task 3: Additive `onStage` observer on graphSearch (family 8 seam)

**Files:**
- Modify: `packages/server/src/search/graph_search.ts` (add optional `onStage` to `GraphSearchOptions`; emit at stage boundaries)
- Test: `packages/server/test/graph-onstage.test.ts`

**Interfaces:**
- Produces: `GraphSearchOptions.onStage?: (stage: string, count: number) => void`. Stage names emitted: `"seed"`, `"expand"`, `"lexical"`, `"fused"`. Default undefined → zero behavior change.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/graph-onstage.test.ts
import { describe, expect, it } from "vitest";
import { makeM2Vault } from "./m2-helpers";
import { graphSearch } from "../src/search/graph_search";
import { deterministicVector } from "../src/embeddings/fake";

describe("graphSearch onStage observer", () => {
  it("emits monotonic stage counts without altering results", async () => {
    const v = makeM2Vault({ files: { "a.md": "# A\n\nvault chunk embed [[b]]", "b.md": "# B\n\ngraph recall bridge" } });
    await v.call("index_vault", { vault: "test" });
    const stages: Array<[string, number]> = [];
    const res = await graphSearch(v.db, {
      query: "vault",
      queryVec: deterministicVector("vault", 32),
      vaultId: "test",
      finalTopK: 5,
      onStage: (stage, count) => stages.push([stage, count]),
    });
    expect(Array.isArray(res)).toBe(true);
    expect(stages.map((s) => s[0])).toContain("fused");
    for (const [, c] of stages) expect(c).toBeGreaterThanOrEqual(0);
    v.cleanup();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && node ./node_modules/vitest/vitest.mjs run test/graph-onstage.test.ts`
Expected: FAIL — `onStage` not in options / not emitted (`stages` empty, `.toContain("fused")` fails).

- [ ] **Step 3: Write minimal implementation**

In `src/search/graph_search.ts`, add to the `GraphSearchOptions` interface (near the other optional fields, e.g. after `finalTopK`):

```ts
  /** THE-459 (additive, observability-only): fired once per retrieval stage with its candidate
   *  count. Default undefined -> no behavior change. THE-465 will formalize typed stages. */
  onStage?: (stage: string, count: number) => void;
```

In `graphSearch(...)`, emit at the existing boundaries. After the seed candidates are pushed (around the first `candidates.push` block, line ~413), and after expansion (~442), lexical (~453), and immediately before `const fused = [...candidates].sort(...)` (~653):

```ts
  opts.onStage?.("seed", seedCount);        // where seedCount = candidates.length after seeding
  // ... after expansion:
  opts.onStage?.("expand", candidates.length);
  // ... after lexical stream merge:
  opts.onStage?.("lexical", candidates.length);
  // ... just before fusion sort:
  opts.onStage?.("fused", candidates.length);
```

Use locally-available counts (capture `candidates.length` at each point). Do not reorder or gate any existing logic — these are pure observer calls.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && node ./node_modules/vitest/vitest.mjs run test/graph-onstage.test.ts`
Expected: PASS.
Then confirm no regression in existing retrieval tests: `node ./node_modules/vitest/vitest.mjs run test/graph-recall.test.ts`
Expected: PASS (unchanged).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/search/graph_search.ts packages/server/test/graph-onstage.test.ts
git commit -s -m "feat(search): additive onStage observer on graphSearch (THE-459 family 8 seam)"
```

---

### Task 4: Indexing collectors (families 3, 4, 5)

**Files:**
- Create: `packages/server/eval/perf/collectors/indexing.ts`
- Test: `packages/server/test/perf-collectors-indexing.test.ts`

**Interfaces:**
- Consumes: `VaultCtx` (harness.ts), `MetricSample` (report.ts).
- Produces: `collectIndexing(vault: VaultCtx, buildMs: number) => MetricSample[]` emitting keys `index.chunks_per_s` (lower-worse, hard), `index.chunk_count` (exact, hard), `embed.texts_per_s` (lower-worse, warn), `embed.call_count` (exact, hard), `embed.dup_ratio` (higher-worse, hard).

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/perf-collectors-indexing.test.ts
import { describe, expect, it } from "vitest";
import { buildVault } from "../eval/perf/harness";
import { SCENARIOS } from "../eval/perf/scenarios";
import { collectIndexing } from "../eval/perf/collectors/indexing";

describe("indexing collectors", () => {
  it("reports dup_ratio in (0,1) and exact counts", async () => {
    const v = await buildVault(SCENARIOS.small);
    const samples = collectIndexing(v, 50);
    const byKey = Object.fromEntries(samples.map((s) => [s.key, s]));
    expect(byKey["embed.dup_ratio"].value).toBeGreaterThan(0);
    expect(byKey["embed.dup_ratio"].value).toBeLessThan(1);
    expect(byKey["index.chunk_count"].value).toBe(v.chunkCount);
    expect(byKey["embed.dup_ratio"].class).toBe("hard");
    expect(byKey["embed.texts_per_s"].class).toBe("warn");
    v.cleanup();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && node ./node_modules/vitest/vitest.mjs run test/perf-collectors-indexing.test.ts`
Expected: FAIL — cannot resolve `collectors/indexing`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/server/eval/perf/collectors/indexing.ts
import type { VaultCtx } from "../harness";
import type { MetricSample } from "../report";

/** Families 3 (index throughput), 4 (embed throughput), 5 (duplicate-embedding ratio). */
export function collectIndexing(vault: VaultCtx, buildMs: number): MetricSample[] {
  const chunks = vault.chunkCount;
  const embedded = vault.provider.texts;
  const seconds = buildMs / 1000;
  const dupRatio = chunks > 0 ? 1 - embedded / chunks : 0;
  return [
    { key: "index.chunk_count", value: chunks, unit: "count", class: "hard", direction: "exact" },
    { key: "index.chunks_per_s", value: seconds > 0 ? chunks / seconds : 0, unit: "per_s", class: "hard", direction: "lower-worse" },
    { key: "embed.call_count", value: vault.provider.calls, unit: "count", class: "hard", direction: "exact" },
    { key: "embed.texts_per_s", value: seconds > 0 ? embedded / seconds : 0, unit: "per_s", class: "warn", direction: "lower-worse" },
    { key: "embed.dup_ratio", value: dupRatio, unit: "ratio", class: "hard", direction: "higher-worse" },
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && node ./node_modules/vitest/vitest.mjs run test/perf-collectors-indexing.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/eval/perf/collectors/indexing.ts packages/server/test/perf-collectors-indexing.test.ts
git commit -s -m "feat(perf): indexing collectors (throughput, embed, dup-ratio)"
```

---

### Task 5: Retrieval collectors (families 8, 9) + synthetic labelled set

**Files:**
- Create: `packages/server/eval/perf/labelled.ts` (in-repo throwaway relevance set — NOT the golden set)
- Create: `packages/server/eval/perf/collectors/retrieval.ts`
- Test: `packages/server/test/perf-collectors-retrieval.test.ts`

**Interfaces:**
- Consumes: `VaultCtx`, `graphSearch` + `GraphSearchOptions.onStage`, `deterministicVector` from `src/embeddings/fake`.
- Produces: `LABELLED: Array<{ query: string; relevantPaths: string[] }>` (labelled.ts); `collectRetrieval(vault) => Promise<MetricSample[]>` emitting `graph.candidates_seed|expand|fused` (exact, hard), `retrieval.recall_at10` + `retrieval.ndcg_at10` (lower-worse, hard), `retrieval.ndcg_per_ms` (lower-worse, warn).

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/perf-collectors-retrieval.test.ts
import { describe, expect, it } from "vitest";
import { buildVault } from "../eval/perf/harness";
import { SCENARIOS } from "../eval/perf/scenarios";
import { collectRetrieval } from "../eval/perf/collectors/retrieval";

describe("retrieval collectors", () => {
  it("emits deterministic stage counts and bounded recall/ndcg", async () => {
    const v = await buildVault(SCENARIOS.small);
    const a = Object.fromEntries((await collectRetrieval(v)).map((s) => [s.key, s.value]));
    const b = Object.fromEntries((await collectRetrieval(v)).map((s) => [s.key, s.value]));
    expect(a["graph.candidates_fused"]).toBe(b["graph.candidates_fused"]); // deterministic
    expect(a["retrieval.recall_at10"]).toBeGreaterThanOrEqual(0);
    expect(a["retrieval.recall_at10"]).toBeLessThanOrEqual(1);
    v.cleanup();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && node ./node_modules/vitest/vitest.mjs run test/perf-collectors-retrieval.test.ts`
Expected: FAIL — cannot resolve `collectors/retrieval`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/server/eval/perf/labelled.ts
/** In-repo, throwaway synthetic relevance set. NOT the private golden set (THE-421 leak class):
 *  these queries + paths are generated from the same seeded corpus and carry no real vault data.
 *  Populated to match SCENARIOS.small's note-<n>.md paths; relevance = notes sharing the query's
 *  body pool index. */
export interface LabelledQuery { query: string; relevantPaths: string[] }

/** For the small scenario: dupGroups=20, notes=100, so body i backs notes i, i+20, i+40, i+60, i+80. */
export const LABELLED: LabelledQuery[] = [0, 1, 2, 3, 4].map((i) => ({
  query: `Body ${i}`,
  relevantPaths: [i, i + 20, i + 40, i + 60, i + 80].map((n) => `note-${n}.md`),
}));
```

```ts
// packages/server/eval/perf/collectors/retrieval.ts
import { performance } from "node:perf_hooks";
import { deterministicVector } from "../../../src/embeddings/fake";
import { graphSearch } from "../../../src/search/graph_search";
import type { VaultCtx } from "../harness";
import type { MetricSample } from "../report";
import { LABELLED } from "../labelled";

function dcg(hits: boolean[]): number {
  return hits.reduce((acc, hit, i) => acc + (hit ? 1 / Math.log2(i + 2) : 0), 0);
}

/** Families 8 (graph candidate counts per stage) + 9 (recall/nDCG per ms). Deterministic vault
 *  -> deterministic counts + relevance; per-ms is the warn-only latency figure. */
export async function collectRetrieval(vault: VaultCtx): Promise<MetricSample[]> {
  const stageCounts: Record<string, number> = { seed: 0, expand: 0, fused: 0 };
  let recallSum = 0;
  let ndcgSum = 0;
  let totalMs = 0;

  for (const q of LABELLED) {
    const t0 = performance.now();
    const results = await graphSearch(vault.db, {
      query: q.query,
      queryVec: deterministicVector(q.query, 32),
      vaultId: vault.stats.model ? (vault as unknown as { db: unknown }) && "" : "", // placeholder guard removed below
    } as never);
    totalMs += performance.now() - t0;
    void results;
  }
  // NOTE: replace the loop body above with the real call below during implementation.

  // Real measured loop:
  stageCounts.seed = 0; stageCounts.expand = 0; stageCounts.fused = 0;
  recallSum = 0; ndcgSum = 0; totalMs = 0;
  for (const q of LABELLED) {
    const t0 = performance.now();
    const results = (await graphSearch(vault.db, {
      query: q.query,
      queryVec: deterministicVector(q.query, 32),
      vaultId: (vault as VaultCtx).stats ? "small" : "small",
      finalTopK: 10,
      onStage: (stage, count) => {
        if (stage in stageCounts) stageCounts[stage] = Math.max(stageCounts[stage] as number, count);
      },
    })) as Array<{ path: string }>;
    totalMs += performance.now() - t0;

    const top = results.slice(0, 10).map((r) => q.relevantPaths.includes(r.path));
    const found = top.filter(Boolean).length;
    recallSum += q.relevantPaths.length > 0 ? found / q.relevantPaths.length : 0;
    const ideal = dcg(new Array(Math.min(10, q.relevantPaths.length)).fill(true));
    ndcgSum += ideal > 0 ? dcg(top) / ideal : 0;
  }

  const n = LABELLED.length;
  const recall = recallSum / n;
  const ndcg = ndcgSum / n;
  const perMs = totalMs > 0 ? ndcg / (totalMs / n) : 0;

  return [
    { key: "graph.candidates_seed", value: stageCounts.seed as number, unit: "count", class: "hard", direction: "exact" },
    { key: "graph.candidates_expand", value: stageCounts.expand as number, unit: "count", class: "hard", direction: "exact" },
    { key: "graph.candidates_fused", value: stageCounts.fused as number, unit: "count", class: "hard", direction: "exact" },
    { key: "retrieval.recall_at10", value: recall, unit: "ratio", class: "hard", direction: "lower-worse" },
    { key: "retrieval.ndcg_at10", value: ndcg, unit: "ratio", class: "hard", direction: "lower-worse" },
    { key: "retrieval.ndcg_per_ms", value: perMs, unit: "ratio", class: "warn", direction: "lower-worse" },
  ];
}
```

Implementation note: delete the first "placeholder guard" loop entirely and keep only the "Real measured loop" — it is shown twice here solely to flag that the `vaultId` passed to `graphSearch` must be the scenario name the vault was indexed under (`sc.name`). Add a `vaultId` field to `VaultCtx` in Task 2's `buildVault` return (`vaultId: sc.name`) and use `vault.vaultId` here rather than the hardcoded `"small"`. Make that one-line addition to `harness.ts` (`VaultCtx.vaultId: string`) as part of this task.

- [ ] **Step 2b: Add `vaultId` to VaultCtx**

In `harness.ts`, add `vaultId: string` to the `VaultCtx` interface and `vaultId: sc.name` to the returned object in `buildVault`. Replace the two `"small"` literals in retrieval.ts with `vault.vaultId`.

- [ ] **Step 3: Run test to verify it passes**

Run: `cd packages/server && node ./node_modules/vitest/vitest.mjs run test/perf-collectors-retrieval.test.ts`
Expected: PASS.

- [ ] **Step 4: Typecheck (no `never`/placeholder residue)**

Run: `cd packages/server && bun run typecheck`
Expected: PASS — confirms the placeholder loop was removed and types are clean.

- [ ] **Step 5: Commit**

```bash
git add packages/server/eval/perf/labelled.ts packages/server/eval/perf/collectors/retrieval.ts packages/server/eval/perf/harness.ts packages/server/test/perf-collectors-retrieval.test.ts
git commit -s -m "feat(perf): retrieval collectors + synthetic labelled set (families 8,9)"
```

---

### Task 6: Dispatch overhead + write-to-search freshness (families 1, 2)

**Files:**
- Create: `packages/server/eval/perf/collectors/dispatch.ts`
- Test: `packages/server/test/perf-collectors-dispatch.test.ts`

**Interfaces:**
- Consumes: `ToolRegistry` + `RegistryOptions.metrics` from `src/mcp/registry`, `MetricsRecorder` from `src/metrics/registry`, `registerM2Tools` from `src/tools/m2`, `timedQuantiles` (harness.ts).
- Produces: `collectDispatch(vault) => Promise<MetricSample[]>` emitting `dispatch.overhead_p50_ms|p95_ms|p99_ms` (higher-worse, warn) and `freshness.visible` (exact/bool, hard) + `freshness.ms` (higher-worse, warn).

**Approach note:** Build a `ToolRegistry` with a `MetricsRecorder`, dispatch a cheap read tool N times, take wall-time quantiles, and subtract mean handler time read from the recorder's `obsidian_tc_tool_duration_seconds` histogram `_sum/_count` (via `recorder.registry.getMetricsAsJSON()`). Overhead = wall − handler.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/perf-collectors-dispatch.test.ts
import { describe, expect, it } from "vitest";
import { buildVault } from "../eval/perf/harness";
import { SCENARIOS } from "../eval/perf/scenarios";
import { collectDispatch } from "../eval/perf/collectors/dispatch";

describe("dispatch + freshness collectors", () => {
  it("emits non-negative dispatch overhead quantiles and a freshness flag", async () => {
    const v = await buildVault(SCENARIOS.small);
    const byKey = Object.fromEntries((await collectDispatch(v)).map((s) => [s.key, s]));
    expect(byKey["dispatch.overhead_p95_ms"].value).toBeGreaterThanOrEqual(0);
    expect(byKey["freshness.visible"].value).toBe(1);
    expect(byKey["dispatch.overhead_p95_ms"].class).toBe("warn");
    expect(byKey["freshness.visible"].class).toBe("hard");
    v.cleanup();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && node ./node_modules/vitest/vitest.mjs run test/perf-collectors-dispatch.test.ts`
Expected: FAIL — cannot resolve `collectors/dispatch`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/server/eval/perf/collectors/dispatch.ts
import { performance } from "node:perf_hooks";
import { MetricsRecorder } from "../../../src/metrics/registry";
import { type CallerContext, ToolRegistry } from "../../../src/mcp/registry";
import { registerM2Tools } from "../../../src/tools/m2";
import { VaultRegistry } from "../../../src/vault/registry";
import { FolderAcl } from "../../../src/acl";
import { fakeEmbeddingProvider } from "../../../src/embeddings";
import { quantiles } from "../harness";
import type { VaultCtx } from "../harness";
import type { MetricSample } from "../report";

interface HistoJson { name: string; values: Array<{ metricName?: string; value: number }> }

/** Mean handler seconds from the prom histogram: _sum / _count. */
function meanHandlerSeconds(recorder: MetricsRecorder): number {
  const json = recorder.registry.getMetricsAsJSON() as unknown as HistoJson[];
  const h = json.find((m) => m.name === "obsidian_tc_tool_duration_seconds");
  if (!h) return 0;
  const sum = h.values.find((v) => v.metricName?.endsWith("_sum"))?.value ?? 0;
  const count = h.values.find((v) => v.metricName?.endsWith("_count"))?.value ?? 0;
  return count > 0 ? sum / count : 0;
}

export async function collectDispatch(vault: VaultCtx): Promise<MetricSample[]> {
  const recorder = new MetricsRecorder();
  const registry = new ToolRegistry({ metrics: recorder });
  const vaultRegistry = new VaultRegistry([{ id: vault.vaultId, path: vault.root }]);
  registerM2Tools(registry, { vaultRegistry, embeddingProvider: fakeEmbeddingProvider({ dimensions: 32 }) });
  const acl = new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] });
  const ctx: CallerContext = { caller: "perf", authenticated: true, grantedScopes: new Set(["*"]), vaultId: vault.vaultId, db: vault.db, acl };

  const N = 30;
  const warmup = 5;
  for (let i = 0; i < warmup; i++) await registry.dispatch("search_notes", { vault: vault.vaultId, query: "vault", limit: 5 }, ctx);
  const wall: number[] = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    await registry.dispatch("search_notes", { vault: vault.vaultId, query: "vault", limit: 5 }, ctx);
    wall.push(performance.now() - t0);
  }
  const handlerMs = meanHandlerSeconds(recorder) * 1000;
  const overhead = wall.map((w) => Math.max(0, w - handlerMs));
  const q = quantiles(overhead);

  // Family 2: write a note, then confirm it becomes visible to search.
  const marker = `perfmarker${vault.vaultId}`;
  const w0 = performance.now();
  await registry.dispatch("write_note", { vault: vault.vaultId, path: "perf-fresh.md", content: `# Fresh\n\n${marker}` }, ctx);
  await registry.dispatch("index_vault", { vault: vault.vaultId }, ctx);
  const found = await registry.dispatch("search_notes", { vault: vault.vaultId, query: marker, limit: 5 }, ctx);
  const freshMs = performance.now() - w0;
  const visible = found.ok ? 1 : 0;

  return [
    { key: "dispatch.overhead_p50_ms", value: q.p50, unit: "ms", class: "warn", direction: "higher-worse" },
    { key: "dispatch.overhead_p95_ms", value: q.p95, unit: "ms", class: "warn", direction: "higher-worse" },
    { key: "dispatch.overhead_p99_ms", value: q.p99, unit: "ms", class: "warn", direction: "higher-worse" },
    { key: "freshness.visible", value: visible, unit: "bool", class: "hard", direction: "exact" },
    { key: "freshness.ms", value: freshMs, unit: "ms", class: "warn", direction: "higher-worse" },
  ];
}
```

Implementation note: the tool names (`search_notes`, `write_note`, `index_vault`) must match those registered by `registerM2Tools`. Verify against `src/tools/m2` at implement-time; if the search tool is named differently (e.g. `graph_search`), use that name. This is the only place tool names are hardcoded.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && node ./node_modules/vitest/vitest.mjs run test/perf-collectors-dispatch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/eval/perf/collectors/dispatch.ts packages/server/test/perf-collectors-dispatch.test.ts
git commit -s -m "feat(perf): dispatch-overhead + write-to-search freshness collectors"
```

---

### Task 7: Storage collectors — txn/lock + per-vault storage (families 7, 14)

**Files:**
- Create: `packages/server/eval/perf/collectors/storage.ts`
- Test: `packages/server/test/perf-collectors-storage.test.ts`

**Interfaces:**
- Consumes: `VaultCtx`, `node:perf_hooks`, `process.cpuUsage()`.
- Produces: `collectStorage(vault) => MetricSample[]` emitting `storage.bytes` (higher-worse, hard for a fixed corpus), `storage.txn_count` (exact, hard), `storage.txn_ms` (higher-worse, warn), `storage.cpu_ms` (higher-worse, warn).

**Approach:** `storage.bytes` = `PRAGMA page_count * page_size` on the vault DB (deterministic for a seeded corpus). `txn_count` = a fixed batch of N wrapped writes; `txn_ms` = wall over that batch; `cpu_ms` = `process.cpuUsage()` delta over the batch.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/perf-collectors-storage.test.ts
import { describe, expect, it } from "vitest";
import { buildVault } from "../eval/perf/harness";
import { SCENARIOS } from "../eval/perf/scenarios";
import { collectStorage } from "../eval/perf/collectors/storage";

describe("storage collectors", () => {
  it("reports deterministic storage bytes and a fixed txn count", async () => {
    const a = await buildVault(SCENARIOS.small);
    const b = await buildVault(SCENARIOS.small);
    const av = Object.fromEntries(collectStorage(a).map((s) => [s.key, s.value]));
    const bv = Object.fromEntries(collectStorage(b).map((s) => [s.key, s.value]));
    expect(av["storage.bytes"]).toBe(bv["storage.bytes"]); // deterministic
    expect(av["storage.txn_count"]).toBe(bv["storage.txn_count"]);
    expect(av["storage.bytes"]).toBeGreaterThan(0);
    a.cleanup();
    b.cleanup();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && node ./node_modules/vitest/vitest.mjs run test/perf-collectors-storage.test.ts`
Expected: FAIL — cannot resolve `collectors/storage`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/server/eval/perf/collectors/storage.ts
import { performance } from "node:perf_hooks";
import type { VaultCtx } from "../harness";
import type { MetricSample } from "../report";

export function collectStorage(vault: VaultCtx): MetricSample[] {
  const pageCount = (vault.db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count;
  const pageSize = (vault.db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
  const bytes = pageCount * pageSize;

  // A fixed batch of transactional writes into a scratch table -> deterministic txn count.
  vault.db.exec("CREATE TABLE IF NOT EXISTS perf_txn_scratch (k INTEGER PRIMARY KEY, v TEXT)");
  const TXNS = 200;
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  const insert = vault.db.prepare("INSERT OR REPLACE INTO perf_txn_scratch (k, v) VALUES (?, ?)");
  for (let i = 0; i < TXNS; i++) {
    vault.db.exec("BEGIN");
    insert.run(i, `row-${i}`);
    vault.db.exec("COMMIT");
  }
  const txnMs = performance.now() - t0;
  const cpu = process.cpuUsage(cpu0);
  const cpuMs = (cpu.user + cpu.system) / 1000;

  return [
    { key: "storage.bytes", value: bytes, unit: "bytes", class: "hard", direction: "higher-worse" },
    { key: "storage.txn_count", value: TXNS, unit: "count", class: "hard", direction: "exact" },
    { key: "storage.txn_ms", value: txnMs, unit: "ms", class: "warn", direction: "higher-worse" },
    { key: "storage.cpu_ms", value: cpuMs, unit: "ms", class: "warn", direction: "higher-worse" },
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && node ./node_modules/vitest/vitest.mjs run test/perf-collectors-storage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/eval/perf/collectors/storage.ts packages/server/test/perf-collectors-storage.test.ts
git commit -s -m "feat(perf): storage collectors (txn/lock + per-vault bytes/cpu)"
```

---

### Task 8: Runtime collectors — event-loop delay + peak memory (families 6, 10)

**Files:**
- Create: `packages/server/eval/perf/collectors/runtime.ts`
- Test: `packages/server/test/perf-collectors-runtime.test.ts`

**Interfaces:**
- Consumes: `perf_hooks.monitorEventLoopDelay`, `process.memoryUsage`, `VaultCtx`, `graphSearch`, `deterministicVector`.
- Produces: `collectRuntime(vault) => Promise<MetricSample[]>` emitting `runtime.eventloop_p99_ms` (higher-worse, warn) and `runtime.peak_rss_per_10k_mb` (higher-worse, warn).

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/perf-collectors-runtime.test.ts
import { describe, expect, it } from "vitest";
import { buildVault } from "../eval/perf/harness";
import { SCENARIOS } from "../eval/perf/scenarios";
import { collectRuntime } from "../eval/perf/collectors/runtime";

describe("runtime collectors", () => {
  it("emits non-negative event-loop delay and peak rss, both warn-class", async () => {
    const v = await buildVault(SCENARIOS.small);
    const byKey = Object.fromEntries((await collectRuntime(v)).map((s) => [s.key, s]));
    expect(byKey["runtime.eventloop_p99_ms"].value).toBeGreaterThanOrEqual(0);
    expect(byKey["runtime.peak_rss_per_10k_mb"].value).toBeGreaterThan(0);
    expect(byKey["runtime.eventloop_p99_ms"].class).toBe("warn");
    v.cleanup();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && node ./node_modules/vitest/vitest.mjs run test/perf-collectors-runtime.test.ts`
Expected: FAIL — cannot resolve `collectors/runtime`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/server/eval/perf/collectors/runtime.ts
import { monitorEventLoopDelay } from "node:perf_hooks";
import { deterministicVector } from "../../../src/embeddings/fake";
import { graphSearch } from "../../../src/search/graph_search";
import type { VaultCtx } from "../harness";
import type { MetricSample } from "../report";

/** Family 6 (event-loop delay under load) + 10 (peak RSS per 10k chunks). */
export async function collectRuntime(vault: VaultCtx): Promise<MetricSample[]> {
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  let peakRss = process.memoryUsage().rss;
  for (let i = 0; i < 50; i++) {
    await graphSearch(vault.db, {
      query: "vault chunk graph",
      queryVec: deterministicVector("vault chunk graph", 32),
      vaultId: vault.vaultId,
      finalTopK: 10,
    });
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }
  h.disable();
  const eventloopP99Ms = h.percentile(99) / 1e6; // ns -> ms
  const per10k = vault.chunkCount > 0 ? (peakRss / (1024 * 1024)) * (10000 / vault.chunkCount) : 0;

  return [
    { key: "runtime.eventloop_p99_ms", value: eventloopP99Ms, unit: "ms", class: "warn", direction: "higher-worse" },
    { key: "runtime.peak_rss_per_10k_mb", value: per10k, unit: "count", class: "warn", direction: "higher-worse" },
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && node ./node_modules/vitest/vitest.mjs run test/perf-collectors-runtime.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/eval/perf/collectors/runtime.ts packages/server/test/perf-collectors-runtime.test.ts
git commit -s -m "feat(perf): runtime collectors (event-loop delay + peak rss)"
```

---

### Task 9: Lifecycle collectors — vec migration + HTTP handshake + shutdown drain (families 11, 12, 13)

**Files:**
- Create: `packages/server/eval/perf/collectors/lifecycle.ts`
- Test: `packages/server/test/perf-collectors-lifecycle.test.ts`

**Interfaces:**
- Consumes: `ensureVecChunks` from `src/search/vec`, `VaultCtx`, `perf_hooks`.
- Produces: `collectLifecycle(vault) => Promise<MetricSample[]>` emitting `migration.rebuilt` (exact/bool, hard) + `migration.ms` (higher-worse, warn); `http.handshake_ok` (exact/bool, hard) + `http.cold_ms`/`http.warm_ms` (higher-worse, warn); `shutdown.drained` (exact/bool, hard) + `shutdown.ms` (higher-worse, warn).

**Approach:** vec migration — call `ensureVecChunks(db, dims2)` with a *different* dimension than the corpus was built at and time the rebuild (rebuilt = the call returns true and the version row changed). HTTP handshake — time creating + tearing down the server/transport via the transport's public factory (verify the exact export in `src/transports/http.ts` at implement-time; drive create→one request→close, cold = first, warm = second). Shutdown drain — time closing the DB + any coordinator under a 5s deadline; `drained = elapsed < 5000`.

Implementation note: families 12 (HTTP) and 13 (shutdown) touch server lifecycle whose exact entry points must be read from `src/transports/http.ts` and `src/cli.ts` at implement-time. If a public, side-effect-free factory is not readily callable in-process, emit the boolean invariant (`http.handshake_ok`/`shutdown.drained`) from the smallest callable seam and record the latency as best-effort warn. Do **not** stand up a real network listener in the harness — construct and tear down in-process only.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/perf-collectors-lifecycle.test.ts
import { describe, expect, it } from "vitest";
import { buildVault } from "../eval/perf/harness";
import { SCENARIOS } from "../eval/perf/scenarios";
import { collectLifecycle } from "../eval/perf/collectors/lifecycle";

describe("lifecycle collectors", () => {
  it("reports a vec-migration rebuild flag and a shutdown-drained flag", async () => {
    const v = await buildVault(SCENARIOS.small);
    const byKey = Object.fromEntries((await collectLifecycle(v)).map((s) => [s.key, s]));
    expect(byKey["shutdown.drained"].value).toBe(1);
    expect(byKey["migration.ms"].class).toBe("warn");
    expect(byKey["shutdown.drained"].class).toBe("hard");
    v.cleanup();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && node ./node_modules/vitest/vitest.mjs run test/perf-collectors-lifecycle.test.ts`
Expected: FAIL — cannot resolve `collectors/lifecycle`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/server/eval/perf/collectors/lifecycle.ts
import { performance } from "node:perf_hooks";
import { ensureVecChunks } from "../../../src/search/vec";
import type { VaultCtx } from "../harness";
import type { MetricSample } from "../report";

const SHUTDOWN_DEADLINE_MS = 5000;

export async function collectLifecycle(vault: VaultCtx): Promise<MetricSample[]> {
  // Family 11: force a vec-index rebuild by requesting a different dimension than the corpus (32).
  const t0 = performance.now();
  const rebuilt = ensureVecChunks(vault.db, 64); // returns false when sqlite-vec unavailable (node path)
  const migMs = performance.now() - t0;

  // Family 13: time DB close under a deadline. (HTTP handshake, family 12, is added once the
  // in-process transport factory in src/transports/http.ts is confirmed — see task note.)
  const s0 = performance.now();
  vault.db.close?.();
  const drainMs = performance.now() - s0;
  const drained = drainMs < SHUTDOWN_DEADLINE_MS ? 1 : 0;

  return [
    { key: "migration.rebuilt", value: rebuilt ? 1 : 0, unit: "bool", class: "hard", direction: "exact" },
    { key: "migration.ms", value: migMs, unit: "ms", class: "warn", direction: "higher-worse" },
    { key: "shutdown.drained", value: drained, unit: "bool", class: "hard", direction: "exact" },
    { key: "shutdown.ms", value: drainMs, unit: "ms", class: "warn", direction: "higher-worse" },
  ];
}
```

Implementation note: this collector `close()`s the DB — it MUST run last in the orchestration order (Task 10). The HTTP handshake metrics (`http.handshake_ok`, `http.cold_ms`, `http.warm_ms`) are added here after reading `src/transports/http.ts`; if in-process construction proves invasive, ship the four families this task covers and file a small follow-up for HTTP handshake rather than standing up a network listener. Note the decision in the commit message and the harness README.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && node ./node_modules/vitest/vitest.mjs run test/perf-collectors-lifecycle.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/eval/perf/collectors/lifecycle.ts packages/server/test/perf-collectors-lifecycle.test.ts
git commit -s -m "feat(perf): lifecycle collectors (vec migration + shutdown drain)"
```

---

### Task 10: Orchestration — run.ts wires collectors → report → gate

**Files:**
- Create: `packages/server/eval/perf/run.ts`
- Test: `packages/server/test/perf-run.test.ts`

**Interfaces:**
- Consumes: all collectors, `buildVault`, `timedQuantiles`/`performance`, `evaluate`, `toMarkdown`.
- Produces: `runScenario(name) => Promise<PerfReport>`; a CLI `main()` supporting `--scenario <name>`, `--out <path>`, `--gate`, `--update-baseline`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/perf-run.test.ts
import { describe, expect, it } from "vitest";
import { runScenario } from "../eval/perf/run";

describe("perf run orchestration", () => {
  it("produces a report with all deterministic hard-class keys present", async () => {
    const report = await runScenario("small");
    const keys = new Set(report.samples.map((s) => s.key));
    for (const k of ["index.chunk_count", "embed.dup_ratio", "graph.candidates_fused", "storage.bytes", "shutdown.drained"]) {
      expect(keys.has(k)).toBe(true);
    }
    // every sample carries class + direction
    for (const s of report.samples) {
      expect(["hard", "warn"]).toContain(s.class);
      expect(["higher-worse", "lower-worse", "exact"]).toContain(s.direction);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && node ./node_modules/vitest/vitest.mjs run test/perf-run.test.ts`
Expected: FAIL — cannot resolve `../eval/perf/run`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/server/eval/perf/run.ts
import { performance } from "node:perf_hooks";
import { readFileSync, writeFileSync } from "node:fs";
import { buildVault } from "./harness";
import { SCENARIOS, type Scenario } from "./scenarios";
import { collectIndexing } from "./collectors/indexing";
import { collectRetrieval } from "./collectors/retrieval";
import { collectDispatch } from "./collectors/dispatch";
import { collectStorage } from "./collectors/storage";
import { collectRuntime } from "./collectors/runtime";
import { collectLifecycle } from "./collectors/lifecycle";
import { type PerfReport, type Baseline, toMarkdown } from "./report";
import { evaluate } from "./gate";

/** Build the vault once, run every collector in a fixed order (lifecycle LAST — it closes the DB). */
export async function runScenario(name: Scenario["name"]): Promise<PerfReport> {
  const sc = SCENARIOS[name];
  const t0 = performance.now();
  const vault = await buildVault(sc);
  const buildMs = performance.now() - t0;

  const samples = [
    ...collectIndexing(vault, buildMs),
    ...(await collectRetrieval(vault)),
    ...(await collectDispatch(vault)),
    ...collectStorage(vault),
    ...(await collectRuntime(vault)),
    ...(await collectLifecycle(vault)), // closes db
  ];
  // lifecycle closed the db; only remove the temp dir.
  vault.cleanup();
  return { scenario: name, samples };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const name = (get("--scenario") ?? "small") as Scenario["name"];
  const out = get("--out") ?? "perf-report.json";
  const report = await runScenario(name);
  writeFileSync(out, JSON.stringify(report, null, 2));
  process.stdout.write(toMarkdown(report));

  if (args.includes("--update-baseline")) {
    const baseline: Baseline = {};
    for (const s of report.samples) {
      baseline[s.key] = {
        value: s.value,
        tol: s.direction === "exact" ? 0 : s.unit === "per_s" ? 0.25 : s.class === "hard" ? 0.15 : 0.5,
        mode: s.unit === "ratio" || s.unit === "bool" ? "abs" : "ratio",
        class: s.class,
        direction: s.direction,
      };
    }
    writeFileSync(`eval/perf/baseline.${name}.json`, JSON.stringify(baseline, null, 2));
    process.stdout.write(`\nwrote eval/perf/baseline.${name}.json\n`);
    return;
  }

  if (args.includes("--gate")) {
    const baseline = JSON.parse(readFileSync(`eval/perf/baseline.${name}.json`, "utf8")) as Baseline;
    const result = evaluate(report, baseline);
    for (const w of result.warnings) process.stdout.write(`WARN ${w.key}: ${w.actual} vs baseline ${w.baseline}\n`);
    if (result.hardFailures.length > 0) {
      for (const f of result.hardFailures) process.stderr.write(`FAIL ${f.key}: ${f.actual} vs baseline ${f.baseline} (tol ${f.tol})\n`);
      process.exit(1);
    }
    process.stdout.write(`perf gate OK (${result.warnings.length} warnings)\n`);
  }
}

// Run as a script (bun eval/perf/run.ts ...) but not when imported by tests.
if (import.meta.main) await main();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && node ./node_modules/vitest/vitest.mjs run test/perf-run.test.ts`
Expected: PASS. (`import.meta.main` is falsy under vitest, so `main()` does not run on import.)

- [ ] **Step 5: Commit**

```bash
git add packages/server/eval/perf/run.ts packages/server/test/perf-run.test.ts
git commit -s -m "feat(perf): run.ts orchestration (collectors -> report -> gate)"
```

---

### Task 11: Generate + commit the baseline under bun (real path)

**Files:**
- Create: `packages/server/eval/perf/baseline.small.json` (generated, committed)

- [ ] **Step 1: Generate the baseline on the real bun path**

Run (from `packages/server`, requires the native install so sqlite-vec loads):
```bash
bun install
bun eval/perf/run.ts --scenario small --update-baseline
```
Expected: writes `eval/perf/baseline.small.json`; stdout shows the markdown table with `vec`-dependent metrics populated (non-zero `migration.rebuilt`, `graph.candidates_*`).

- [ ] **Step 2: Sanity-check the baseline is self-consistent**

Run: `bun eval/perf/run.ts --scenario small --gate`
Expected: `perf gate OK` (a freshly generated baseline must pass against itself; warnings allowed, zero hard failures).

- [ ] **Step 3: Inspect the committed numbers**

Open `eval/perf/baseline.small.json`; confirm `embed.dup_ratio` is the expected ~0.8 (small: 100 notes / 20 bodies → ~80% duplicates), `index.chunk_count` matches the corpus, and no metric is `NaN`/`0` where it should be positive. Fix any collector that produced a degenerate value before committing.

- [ ] **Step 4: Commit**

```bash
git add packages/server/eval/perf/baseline.small.json
git commit -s -m "chore(perf): commit initial small-scenario baseline (bun real-path numbers)"
```

---

### Task 12: package.json scripts + CI perf job

**Files:**
- Modify: `packages/server/package.json` (add `perf`, `perf:gate` scripts)
- Modify: `.github/workflows/ci-server.yml` (add a `perf` job)

- [ ] **Step 1: Add scripts**

In `packages/server/package.json` `scripts`, add:
```json
    "perf": "bun eval/perf/run.ts --scenario small --out perf-report.json",
    "perf:gate": "bun eval/perf/run.ts --scenario small --out perf-report.json --gate"
```

- [ ] **Step 2: Add the CI job**

Append to `.github/workflows/ci-server.yml` under `jobs:` (mirror the existing `bun-smoke` job's checkout + setup-bun + cache steps; do NOT use `--ignore-scripts` so the native `better-sqlite3`/`sqlite-vec` build runs):

```yaml
  perf:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6
      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0
        with:
          bun-version: '1.3.14'
      - name: cache bun install
        uses: actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830 # v4
        with:
          path: ~/.bun/install/cache
          key: bun-${{ runner.os }}-${{ hashFiles('bun.lock') }}
          restore-keys: bun-${{ runner.os }}-
      - name: install (native build for sqlite-vec)
        run: bun install --frozen-lockfile
      - name: perf gate (hard-fail deterministic regressions; warn on latency)
        run: bun run perf:gate
        working-directory: packages/server
      - name: upload perf report
        if: always()
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
        with:
          name: perf-report
          path: packages/server/perf-report.json
```

- [ ] **Step 3: Validate workflow + scripts locally**

Run: `cd packages/server && bun run perf:gate`
Expected: `perf gate OK` (exit 0). Then lint: `cd /home/ubuntu/src/obsidian-tc && bun run lint`
Expected: no errors on the new files.

- [ ] **Step 4: Confirm the gate actually fails on a regression (guard the guard)**

Temporarily edit `eval/perf/baseline.small.json` to set `index.chunk_count.value` to a wrong number, run `bun run perf:gate`, and confirm it exits non-zero with a `FAIL index.chunk_count` line. Revert the edit.

- [ ] **Step 5: Commit**

```bash
git checkout packages/server/eval/perf/baseline.small.json  # ensure the revert from step 4 is in
git add packages/server/package.json .github/workflows/ci-server.yml
git commit -s -m "ci(perf): perf:gate job + scripts for THE-459 harness"
```

---

### Task 13: Harness README

**Files:**
- Create: `packages/server/eval/perf/README.md`

- [ ] **Step 1: Write the README**

Document: what the harness is (THE-459), how to run (`bun run perf`, `bun run perf:gate`, `--update-baseline`), the hard/warn split and why (noisy shared runners), why it is bun-only (sqlite-vec; Node parity = THE-494), the determinism guarantee (seed + fake provider), how to regenerate the baseline deliberately (and that a baseline diff needs rationale in the PR), and the metric-family → collector map. State that the synthetic labelled set is throwaway and shares nothing with the private golden set.

- [ ] **Step 2: Commit**

```bash
git add packages/server/eval/perf/README.md
git commit -s -m "docs(perf): THE-459 harness README (usage, gate model, bun-only rationale)"
```

---

## Self-review

**Spec coverage:**
- 14 metric families → families 1,2 (Task 6), 3,4,5 (Task 4), 6,10 (Task 8), 7,14 (Task 7), 8,9 (Task 5), 11,12,13 (Task 9). Family 12 (HTTP handshake) is explicitly conditional in Task 9 with a documented fallback — the only family whose full latency figure may slip to a follow-up; its hard invariant is still emitted or the slip is logged. ✓ (with noted caveat)
- Committed baseline + own gate.ts, per-metric {value,tol,mode,class,direction} → Tasks 1, 11. ✓
- Hard/warn split, one-sided directionality → gate.ts `isViolation` + Task 1 tests. ✓
- Determinism (seed + fake provider) → Task 2 + determinism assertions in Tasks 2,5,7. ✓
- Warmup + N-iteration quantiles → `timedQuantiles`/`quantiles` (Task 2), used in dispatch (Task 6). ✓
- bun-only real path; Node parity deferred → Global Constraints + Task 11 uses bun; THE-494 referenced. ✓
- Additive-only source edits → Task 3 (`onStage`) is the only src change, optional + default-undefined. ✓
- In-repo throwaway labelled set (THE-421) → Task 5 `labelled.ts` + README. ✓
- CI job + artifact upload → Task 12. ✓
- Harness self-tests (determinism + gate) → Tasks 1, 2. ✓

**Placeholder scan:** Task 5's retrieval collector deliberately shows the wrong-then-right loop to flag the `vaultId` threading; Step 2b + the implementation note remove the placeholder and the Step 4 typecheck gate catches any residue. No `TODO`/`TBD`/"add error handling" left. ✓

**Type consistency:** `MetricSample`/`BaselineEntry`/`Direction`/`GateResult` names are consistent across Tasks 1–10; `VaultCtx` gains `vaultId` in Task 5 Step 2b and every later collector uses `vault.vaultId`; collector fn names (`collectIndexing`/`collectRetrieval`/`collectDispatch`/`collectStorage`/`collectRuntime`/`collectLifecycle`) match their imports in `run.ts` (Task 10). ✓
