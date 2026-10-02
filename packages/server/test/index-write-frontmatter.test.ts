// Index-on-write and bad frontmatter YAML. Before: every index-on-write failure went through one
// onError that bumped write_failures, so a typo in a note's YAML tripped the index-stalled alert
// (keyed on write_failures > 0) and a real I/O failure was indistinguishable from it. The reconcile
// (index-vault.ts) already treated the same error kind as skip-and-warn. This pins the same policy
// for the per-write path, end to end through wireIndexCoordinator.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FolderAcl } from "../src/acl";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { MetricsRecorder } from "../src/metrics/registry";
import { syncFrontmatterFailures } from "../src/runtime/index-write-outcome";
import type { IndexHealthState } from "../src/runtime/indexing-wiring";
import { wireIndexCoordinator } from "../src/runtime/indexing-wiring";
import { makeM2Vault } from "./m2-helpers";

const GOOD = "---\ntitle: Fine\n---\n# Fine\n\nA healthy note about oranges.\n";
const BAD = "---\ntitle: [unterminated\n---\n# Broken\n\nStill about oranges.\n";
const NEW_GOOD = "---\ntitle: Repaired\n---\n# Repaired\n\nNow about lemons.\n";

function health(): IndexHealthState {
  return {
    reconcile: "ok",
    reconcileAt: 0,
    reconcileErrors: [],
    writeFailures: 0,
    frontmatterFailures: new Map(),
    notesReady: true,
    auditWriteFailures: 0,
    indexQueueBackpressures: 0,
    lastChunksUpserted: null,
    inFlight: null,
  };
}

function setup() {
  const v = makeM2Vault();
  const metrics = new MetricsRecorder();
  const indexHealth = health();
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const wiring = wireIndexCoordinator({
    db: v.db,
    metrics,
    embeddingProvider: fakeEmbeddingProvider({ dimensions: 32 }),
    hasVec: false,
    chunkContext: false,
    indexing: { writeConcurrency: 2, writeConcurrencyPerVault: 2, queueMax: 100 },
    vaults: [],
    watch: { enabled: false, debounceMs: 0 },
    sqlHooksFor: () => ({}),
    indexHealth,
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    aclByVault: new Map(),
    makeOnIndexed: () => undefined,
  });
  const counter = async (): Promise<number> => {
    const m = /obsidian_tc_index_frontmatter_failures_total\{vault="test"\} (\d+)/.exec(
      await metrics.metrics(),
    );
    return m ? Number(m[1]) : 0;
  };
  const chunks = (path: string): number =>
    (
      v.db
        .prepare("SELECT COUNT(*) AS n FROM chunks WHERE vault_id = ? AND path = ?")
        .get(v.id, path) as { n: number }
    ).n;
  return { v, metrics, indexHealth, wiring, counter, chunks, stderr };
}

afterEach(() => vi.restoreAllMocks());

describe("index-on-write with invalid frontmatter YAML", () => {
  it("does not count a write failure; counts the frontmatter counter, sets the health field, hints on stderr", async () => {
    const t = setup();
    try {
      t.wiring.reindexHook("test", "bad.md", BAD);
      await t.wiring.indexCoordinator.idle();
      expect(t.indexHealth.writeFailures).toBe(0);
      expect(t.indexHealth.lastWriteError).toBeUndefined();
      expect(await t.counter()).toBe(1);
      expect(t.indexHealth.frontmatterFailures.size).toBe(1);
      expect(t.indexHealth.lastFrontmatterFailure).toMatchObject({ vault: "test", path: "bad.md" });
      expect(t.indexHealth.lastFrontmatterFailure?.error).toContain("not valid YAML");
      const written = t.stderr.mock.calls.map((c) => String(c[0])).join("");
      expect(written).toContain('index-on-write skipped "bad.md"');
      expect(written).toContain("fix the note's YAML frontmatter");
      const row = t.v.db
        .prepare("SELECT result_size FROM event_log WHERE event_type = 'index_frontmatter_failed'")
        .get() as { result_size: number } | undefined;
      expect(row?.result_size).toBe(1);
    } finally {
      t.v.cleanup();
    }
  });

  it("retains the old rows when a previously-indexed note's YAML breaks", async () => {
    const t = setup();
    try {
      t.wiring.reindexHook("test", "n.md", GOOD);
      await t.wiring.indexCoordinator.idle();
      const before = t.chunks("n.md");
      expect(before).toBeGreaterThan(0);
      t.wiring.reindexHook("test", "n.md", BAD);
      await t.wiring.indexCoordinator.idle();
      expect(t.chunks("n.md")).toBe(before);
      expect(t.indexHealth.writeFailures).toBe(0);
      expect(t.indexHealth.frontmatterFailures.size).toBe(1);
    } finally {
      t.v.cleanup();
    }
  });

  it("clears the health field once the note is repaired and re-indexed", async () => {
    const t = setup();
    try {
      t.wiring.reindexHook("test", "n.md", BAD);
      await t.wiring.indexCoordinator.idle();
      expect(t.indexHealth.frontmatterFailures.size).toBe(1);
      t.wiring.reindexHook("test", "n.md", NEW_GOOD);
      await t.wiring.indexCoordinator.idle();
      expect(t.indexHealth.frontmatterFailures.size).toBe(0);
      expect(t.indexHealth.lastFrontmatterFailure).toBeUndefined();
      expect(t.chunks("n.md")).toBeGreaterThan(0);
      // the cumulative counter does not go back down
      expect(await t.counter()).toBe(1);
    } finally {
      t.v.cleanup();
    }
  });

  it("a deleted note stops failing", async () => {
    const t = setup();
    try {
      t.wiring.reindexHook("test", "n.md", BAD);
      await t.wiring.indexCoordinator.idle();
      t.wiring.deindexHook("test", "n.md");
      await t.wiring.indexCoordinator.idle();
      expect(t.indexHealth.frontmatterFailures.size).toBe(0);
    } finally {
      t.v.cleanup();
    }
  });

  it("a completed reconcile that sees the note parse clears a stale failure (repaired out of band)", () => {
    const h = health();
    h.frontmatterFailures.set("test\u0000a.md", { vault: "test", path: "a.md", error: "e" });
    h.frontmatterFailures.set("test\u0000b.md", { vault: "test", path: "b.md", error: "e" });
    h.frontmatterFailures.set("other\u0000a.md", { vault: "other", path: "a.md", error: "e" });
    syncFrontmatterFailures(h, "test", [{ path: "b.md" }]);
    expect([...h.frontmatterFailures.keys()].sort()).toEqual(["other\u0000a.md", "test\u0000b.md"]);
  });

  it("a real index failure (not YAML) still increments write_failures and leaves the frontmatter field alone", async () => {
    const t = setup();
    try {
      // Fault: the embedding provider throws, which is an I/O-class failure on the write path.
      const failing = {
        ...fakeEmbeddingProvider({ dimensions: 32 }),
        embed: async () => {
          throw new Error("embedding backend down");
        },
      };
      const wiring = wireIndexCoordinator({
        db: t.v.db,
        metrics: t.metrics,
        embeddingProvider: failing as never,
        hasVec: false,
        chunkContext: false,
        indexing: { writeConcurrency: 2, writeConcurrencyPerVault: 2, queueMax: 100 },
        vaults: [],
        watch: { enabled: false, debounceMs: 0 },
        sqlHooksFor: () => ({}),
        indexHealth: t.indexHealth,
        acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
        aclByVault: new Map(),
        makeOnIndexed: () => undefined,
      });
      wiring.reindexHook("test", "io.md", GOOD);
      await wiring.indexCoordinator.idle();
      expect(t.indexHealth.writeFailures).toBe(1);
      expect(t.indexHealth.lastWriteError).toContain("embedding backend down");
      expect(t.indexHealth.frontmatterFailures.size).toBe(0);
      expect(await t.counter()).toBe(0);
    } finally {
      t.v.cleanup();
    }
  });
});
