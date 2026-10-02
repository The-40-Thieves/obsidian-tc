// Excluded files, live: the vault watcher reports `.obsidian/app.json` changes (the one dot-folder
// file it watches), the reloader reconciles only when the effective list moved, and index-on-write
// honors the list. The watcher cases run against a REAL filesystem, like vault-watcher.test.ts.
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FolderAcl } from "../src/acl";
import type { EmbeddingProvider } from "../src/embeddings";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { MetricsRecorder } from "../src/metrics/registry";
import { createExclusionReloader } from "../src/runtime/exclusion-reload";
import type { IndexHealthState } from "../src/runtime/indexing-wiring";
import { wireIndexCoordinator } from "../src/runtime/indexing-wiring";
import type { GatedReconcile } from "../src/runtime/vault-lock";
import { vaultExclusionFor } from "../src/search/index-exclusion";
import { startVaultWatch } from "../src/vault/watcher";
import { makeM2Vault } from "./m2-helpers";
import { makeTempDir, rmTemp } from "./tmp";

const APP = ".obsidian/app.json";
const arm = (): Promise<void> => new Promise((r) => setTimeout(r, 400));
const until = async (pred: () => boolean, ms = 10_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!pred() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  await new Promise((r) => setTimeout(r, 250));
};

const writeApp = (root: string, filters: string[]): void => {
  mkdirSync(join(root, ".obsidian"), { recursive: true });
  writeFileSync(join(root, APP), JSON.stringify({ userIgnoreFilters: filters }));
};

afterEach(() => vi.restoreAllMocks());

describe("the watcher reports app.json changes", () => {
  it("fires onVaultConfigChange for a write to .obsidian/app.json and never onUpsert/onDelete for it", async () => {
    const root = makeTempDir("tc-excl-watch-");
    const config: string[] = [];
    const upserts: string[] = [];
    const deletes: string[] = [];
    mkdirSync(join(root, ".obsidian"), { recursive: true });
    const stop = startVaultWatch({
      targets: [{ vaultId: "v1", root }],
      debounceMs: 50,
      onUpsert: (_v, p) => upserts.push(p),
      onDelete: (_v, p) => deletes.push(p),
      onVaultConfigChange: (v) => config.push(v),
    });
    try {
      await arm();
      writeApp(root, ["Archive/"]);
      await until(() => config.length >= 1);
      expect(new Set(config)).toEqual(new Set(["v1"]));
      expect(upserts).toEqual([]);
      expect(deletes).toEqual([]);
      // Other dot-folder files stay unwatched.
      config.length = 0;
      writeFileSync(join(root, ".obsidian", "workspace.json"), "{}");
      await until(() => config.length >= 1, 1_000);
      expect(config).toEqual([]);
    } finally {
      stop();
      rmTemp(root);
    }
  });

  it("without an onVaultConfigChange callback an app.json write is simply ignored", async () => {
    const root = makeTempDir("tc-excl-watch-");
    const upserts: string[] = [];
    mkdirSync(join(root, ".obsidian"), { recursive: true });
    const stop = startVaultWatch({
      targets: [{ vaultId: "v1", root }],
      debounceMs: 50,
      onUpsert: (_v, p) => upserts.push(p),
      onDelete: () => undefined,
    });
    try {
      await arm();
      writeApp(root, ["Archive/"]);
      await until(() => upserts.length >= 1, 1_000);
      expect(upserts).toEqual([]);
    } finally {
      stop();
      rmTemp(root);
    }
  });
});

describe("createExclusionReloader", () => {
  const gated = (
    fn: (signal: AbortSignal) => Promise<void>,
    currentRun: () => Promise<void> | undefined = () => undefined,
  ): GatedReconcile => Object.assign(fn, { currentRun });
  const runnerSpy = (): GatedReconcile & { calls: number } => {
    const state = { calls: 0 };
    const fn = gated(async () => {
      state.calls++;
    });
    return Object.defineProperty(fn, "calls", { get: () => state.calls }) as GatedReconcile & {
      calls: number;
    };
  };

  it("reconciles only when the effective list changed, and says so on the log", async () => {
    const v = makeM2Vault({ files: { "a.md": "# a\n" } });
    try {
      writeApp(v.root, ["Archive/"]);
      const log: string[] = [];
      const reloader = createExclusionReloader(v.vaultRegistry, new AbortController().signal, (m) =>
        log.push(m),
      );
      const run = runnerSpy();
      reloader.setRunner(run);
      await reloader.onVaultConfigChange(v.id); // list unchanged since the snapshot
      expect(run.calls).toBe(0);
      writeApp(v.root, ["Archive/", "/\\.draft\\.md$/"]);
      // Bump mtime so the stat-keyed cache cannot serve the old list.
      const future = new Date(Date.now() + 5_000);
      utimesSync(join(v.root, APP), future, future);
      await reloader.onVaultConfigChange(v.id);
      expect(run.calls).toBe(1);
      expect(log.join("")).toContain("Excluded files list changed (2 entries)");
      await reloader.onVaultConfigChange(v.id); // same list again
      expect(run.calls).toBe(1);
      expect(vaultExclusionFor(v.vaultRegistry, v.id).effective).toEqual([
        "Archive/",
        "/\\.draft\\.md$/",
      ]);
    } finally {
      v.cleanup();
    }
  });

  it("waits for a reconcile already in flight before running its own", async () => {
    const v = makeM2Vault({ files: { "a.md": "# a\n" } });
    try {
      const reloader = createExclusionReloader(
        v.vaultRegistry,
        new AbortController().signal,
        () => {},
      );
      const order: string[] = [];
      let release!: () => void;
      const inFlight = new Promise<void>((r) => {
        release = () => {
          order.push("old-run-done");
          r();
        };
      });
      reloader.setRunner(
        gated(
          async () => {
            order.push("new-run");
          },
          () => inFlight,
        ),
      );
      writeApp(v.root, ["Archive/"]);
      const pending = reloader.onVaultConfigChange(v.id);
      await new Promise((r) => setTimeout(r, 50));
      expect(order).toEqual([]);
      release();
      await pending;
      expect(order).toEqual(["old-run-done", "new-run"]);
    } finally {
      v.cleanup();
    }
  });

  it("logs a failed reconcile instead of throwing", async () => {
    const v = makeM2Vault({ files: { "a.md": "# a\n" } });
    try {
      const log: string[] = [];
      const reloader = createExclusionReloader(v.vaultRegistry, new AbortController().signal, (m) =>
        log.push(m),
      );
      reloader.setRunner(
        gated(async () => {
          throw new Error("boom");
        }),
      );
      writeApp(v.root, ["Archive/"]);
      await expect(reloader.onVaultConfigChange(v.id)).resolves.toBeUndefined();
      expect(log.join("")).toContain("reconcile after an Excluded files change failed: boom");
    } finally {
      v.cleanup();
    }
  });
});

describe("wireIndexCoordinator with an exclusion list", () => {
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
  const NOTE = "# Old\n\nARCHIVEWORD lives in this note.\n";

  function setup(
    opts: { leader?: () => boolean; onConfig?: (v: string) => void; watchRoot?: string } = {},
  ) {
    const v = makeM2Vault({
      files: { "Archive/old.md": NOTE, "keep.md": "# Keep\n\nplain note\n" },
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const inner = fakeEmbeddingProvider({ dimensions: 32 });
    const seen: string[] = [];
    const provider: EmbeddingProvider = {
      ...inner,
      embed: async (texts) => {
        seen.push(...texts);
        return inner.embed(texts);
      },
    };
    writeApp(v.root, ["Archive/"]);
    const wiring = wireIndexCoordinator({
      db: v.db,
      metrics: new MetricsRecorder(),
      embeddingProvider: provider,
      hasVec: false,
      chunkContext: false,
      indexing: { writeConcurrency: 2, writeConcurrencyPerVault: 2, queueMax: 100 },
      vaults: opts.watchRoot ? [{ id: v.id, path: opts.watchRoot }] : [],
      watch: { enabled: opts.watchRoot !== undefined, debounceMs: 50 },
      sqlHooksFor: () => ({}),
      indexHealth: health(),
      acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
      aclByVault: new Map(),
      makeOnIndexed: () => undefined,
      indexExclusionFor: (id) => vaultExclusionFor(v.vaultRegistry, id),
      ...(opts.leader ? { isLeader: opts.leader } : {}),
      ...(opts.onConfig ? { onVaultConfigChange: opts.onConfig } : {}),
    });
    const chunks = (path: string): number =>
      (
        v.db
          .prepare("SELECT COUNT(*) AS n FROM chunks WHERE vault_id = ? AND path = ?")
          .get(v.id, path) as { n: number }
      ).n;
    return { v, wiring, seen, chunks };
  }

  it("index-on-write skips an excluded note: no chunks, and the embedder never sees its text", async () => {
    const t = setup();
    try {
      t.wiring.reindexHook(t.v.id, "Archive/old.md", NOTE);
      t.wiring.reindexHook(t.v.id, "keep.md", "# Keep\n\nplain note\n");
      await t.wiring.indexCoordinator.idle();
      expect(t.chunks("Archive/old.md")).toBe(0);
      expect(t.chunks("keep.md")).toBeGreaterThan(0);
      expect(t.seen.some((s) => s.includes("ARCHIVEWORD"))).toBe(false);
      expect(t.seen.some((s) => s.includes("plain note"))).toBe(true);
    } finally {
      t.wiring.stopVaultWatch();
      t.v.cleanup();
    }
  });

  it("a write for a note that was indexed before it was excluded removes the leftover", async () => {
    const t = setup();
    try {
      t.v.db
        .prepare(
          `INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at)
           VALUES (?, ?, ?, '0', '[]', ?, 'h', 1, 1, 1)`,
        )
        .run("stale-1", t.v.id, "Archive/old.md", "ARCHIVEWORD");
      expect(t.chunks("Archive/old.md")).toBe(1);
      t.wiring.reindexHook(t.v.id, "Archive/old.md", NOTE);
      await t.wiring.indexCoordinator.idle();
      expect(t.chunks("Archive/old.md")).toBe(0);
    } finally {
      t.wiring.stopVaultWatch();
      t.v.cleanup();
    }
  });

  it("forwards the app.json watch event to onVaultConfigChange only while this process leads", async () => {
    let leader = false;
    const calls: string[] = [];
    const root = makeTempDir("tc-excl-lead-");
    mkdirSync(join(root, ".obsidian"), { recursive: true });
    const t = setup({ leader: () => leader, onConfig: (id) => calls.push(id), watchRoot: root });
    try {
      await arm();
      writeApp(root, ["One/"]);
      await until(() => calls.length >= 1, 1_500);
      expect(calls).toEqual([]); // follower: nothing
      leader = true;
      writeApp(root, ["Two/"]);
      await until(() => calls.length >= 1);
      expect(new Set(calls)).toEqual(new Set([t.v.id]));
    } finally {
      t.wiring.stopVaultWatch();
      t.v.cleanup();
      rmTemp(root);
    }
  });
});
