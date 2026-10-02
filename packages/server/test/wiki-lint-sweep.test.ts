// The scheduled wiki lint is OPT-IN (default off) and READ-ONLY. These tests pin the three things an
// unattended job must get right: it is not registered unless enabled, its tick runs the same engine
// as lint_wiki over every vault without writing, and it stops between vaults on shutdown.
import { afterEach, describe, expect, it } from "vitest";
import { configFromVaultPath } from "../src/cli/args";
import { wireScheduler } from "../src/runtime/scheduler-wiring";
import { registerWikiLintSweep, summarizeLintReport } from "../src/runtime/wiki-lint-sweep";
import { NO_EXCLUSION } from "../src/search/index-exclusion";
import type { LintReport } from "../src/tools/m7/knowledge/wiki-lint";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";
import { dbCounts, hashTree, makeWikiHarness, type WikiHarness } from "./wiki-test-helpers";

type Task = { name: string; intervalMs: number; run: (signal: AbortSignal) => unknown };
const capture = () => {
  const box: { task: Task | null } = { task: null };
  return {
    box,
    scheduler: {
      register: (t: Task) => {
        box.task = t;
      },
    } as never,
  };
};
const LIVE = new AbortController().signal;

let h: WikiHarness;
afterEach(() => h?.v.cleanup());

function fixture(): WikiHarness {
  h = makeWikiHarness({
    files: {
      "a.md": "[[Missing]]\n",
      "b.md": "no sources\n",
    },
  });
  return h;
}

describe("config: maintenance.wikiLint", () => {
  it("is OFF by default, daily, whole vault, with a note cap", () => {
    const dir = makeTempDir("otc-wikilint-cfg-");
    try {
      const cfg = configFromVaultPath(dir);
      expect(cfg.maintenance.wikiLint).toEqual({
        enabled: false,
        intervalHours: 24,
        maxNotes: 1500,
      });
    } finally {
      rmTemp(dir);
    }
  });
});

describe("registerWikiLintSweep", () => {
  it("registers under `wiki-lint` at the configured interval", () => {
    const { box, scheduler } = capture();
    const hh = fixture();
    registerWikiLintSweep(scheduler, {
      cacheDb: hh.v.db,
      vaults: [{ id: "test", root: hh.v.root }],
      exclusionFor: () => NO_EXCLUSION,
      embeddingModel: "stub:4",
      intervalMs: 3_600_000,
      maxNotes: 100,
    });
    expect(box.task).toMatchObject({ name: "wiki-lint", intervalMs: 3_600_000 });
  });

  it("a tick lints every vault with the shared engine and writes nothing", async () => {
    const { box, scheduler } = capture();
    const hh = fixture();
    const reports: LintReport[] = [];
    registerWikiLintSweep(scheduler, {
      cacheDb: hh.v.db,
      vaults: [{ id: "test", root: hh.v.root }],
      exclusionFor: () => NO_EXCLUSION,
      embeddingModel: "stub:4",
      intervalMs: 1000,
      maxNotes: 100,
      onReport: (r) => reports.push(r),
    });
    const files = hashTree(hh.v.root);
    const rows = dbCounts(hh.v.db);
    await box.task?.run(LIVE);
    expect(reports).toHaveLength(1);
    const kinds = Object.keys(reports[0]?.summary.by_kind ?? {});
    expect(kinds).toEqual(expect.arrayContaining(["unresolved_link", "missing_sources"]));
    expect(hashTree(hh.v.root)).toEqual(files);
    expect(dbCounts(hh.v.db)).toEqual(rows);
    // the tick reports the SAME proposals the tool does
    const viaTool = await hh.data("lint_wiki", {});
    expect(viaTool.summary.by_kind).toEqual(reports[0]?.summary.by_kind);
  });

  it("stops between vaults once shutdown has begun", async () => {
    const { box, scheduler } = capture();
    const hh = fixture();
    const reports: LintReport[] = [];
    registerWikiLintSweep(scheduler, {
      cacheDb: hh.v.db,
      vaults: [
        { id: "test", root: hh.v.root },
        { id: "test", root: hh.v.root },
      ],
      exclusionFor: () => NO_EXCLUSION,
      embeddingModel: "stub:4",
      intervalMs: 1000,
      maxNotes: 100,
      onReport: (r) => reports.push(r),
    });
    const ac = new AbortController();
    ac.abort();
    await box.task?.run(ac.signal);
    expect(reports).toHaveLength(0);
  });

  it("summarizeLintReport names the vault, the counts by kind and what was skipped", () => {
    const line = summarizeLintReport({
      vault: "main",
      checks_run: ["orphans"],
      skipped: [{ check: "quality", reason: "x" }],
      summary: { total: 3, by_kind: { orphan: 2, stale: 1 } },
      proposals: [],
      truncated: [],
      notes: [],
      warnings: {},
    });
    expect(line).toContain("[wiki-lint] main: 3 proposal(s) orphan=2 stale=1 (skipped: quality)");
  });
});

describe("wireScheduler gating", () => {
  function wire(enabled: boolean): string[] {
    const dir = makeTempDir("otc-wikilint-wire-");
    try {
      const config = configFromVaultPath(dir);
      config.maintenance.wikiLint.enabled = enabled;
      const db = openMemoryDb();
      const scheduler = wireScheduler({
        config,
        db,
        vaults: [{ id: "main", root: dir }],
        eventVaultId: "main",
        experientialOpen: false,
        experientialDb: db,
        observability: {
          sqlHooksFor: () => undefined,
          metrics: undefined,
        } as never,
        morgiana: {} as never,
        roles: null,
        jobQueue: {} as never,
        jobRunner: { drainOnce: async () => undefined } as never,
        runReconcile: async () => undefined,
        embeddingProvider: { id: "stub:4" } as never,
        activeSessions: {} as never,
      });
      return scheduler.stats().map((s) => s.job);
    } finally {
      rmTemp(dir);
    }
  }

  it("registers `wiki-lint` only when maintenance.wikiLint.enabled is set", () => {
    expect(wire(false)).not.toContain("wiki-lint");
    expect(wire(true)).toContain("wiki-lint");
  });
});
