// THE-414 guarantee test: folder-ACL path enforcement is now a dispatch stage (registry.runDispatch
// calls enforcePathAcl for every path a tool declares via def.pathAcl), not a per-handler
// convention. This test is the anti-regression backstop: every MUTATING tool (destructive, or
// carrying a mutating scope) MUST either declare a pathAcl extractor OR be listed in the
// EXEMPT_NO_PATH set below with a documented reason. A new mutating tool that touches vault paths
// but forgets pathAcl fails here — closing the "a handler forgot to gate" class (cf. THE-268 /
// v1.9.1, where strictReadDefault was silently ignored in 8 tool files).
//
// Assembly mirrors tool-count.test.ts: registration only builds tool definitions (handlers close
// over deps), so cheap stubs suffice and no live backend is needed.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMutatingScope } from "@the-40-thieves/obsidian-tc-shared";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { RateLimiter } from "../src/throttle";
import { createHealthTool } from "../src/tools/admin/health";
import { registerM1Tools } from "../src/tools/m1";
import { registerM2Tools } from "../src/tools/m2";
import { registerM3Tools } from "../src/tools/m3";
import { registerM4Tools } from "../src/tools/m4";
import { registerM5Tools } from "../src/tools/m5";
import { registerM6Tools } from "../src/tools/m6";
import { registerM7Tools } from "../src/tools/m7";
import { registerM8Tools } from "../src/tools/m8";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";

const NO_THROTTLE = {
  read: { perMinute: 1e6, burst: 1e6 },
  write: { perMinute: 1e6, burst: 1e6 },
  bulk: { perMinute: 1e6, burst: 1e6 },
  execute: { perMinute: 1e6, burst: 1e6 },
  admin: { perMinute: 1e6, burst: 1e6 },
};

// Mutating tools that touch NO caller-controlled vault path, so there is nothing for pathAcl to
// extract. Each entry is a deliberate, documented exemption — NOT a gap. Keep this list tight; a
// tool that DOES take a vault path must declare pathAcl instead of being parked here.
const EXEMPT_NO_PATH = new Set<string>([
  // --- Cache / registry / whole-vault admin: operate on the SQLite cache or the registry, or the
  //     whole vault, not a caller-named vault-relative path.
  "reset_vault_cache", // drops cache rows (chunks/embeddings/idempotency) for a vault; no path arg
  "reload_vault", // re-reads config from disk; no vault-relative path
  "add_vault", // registers a NEW vault by absolute host path (validated by realpath), pre-ACL
  "index_vault", // indexes the whole vault, not a caller-named path (folder is a filter, read-side)
  // --- Computed target path (not derivable from input): the write path is resolved at runtime from
  //     config + input, so it cannot be extracted statically. Enforced handler-side (defense-in-depth).
  "create_periodic_note", // periodic path = resolver({type,date}) under the periodic-notes config
  "find_or_create_periodic_note", // same resolver
  "append_to_periodic_note", // same resolver
  "reflect", // writes <memoryFolder>/reflections/<date>-<slug>.md (server-computed)
  "create_entity", // materializes <memoryFolder>/<type>/<name>.md (server-computed)
  "add_observation", // appends to a computed entity note / entity DB
  "link_entities", // updates computed entity notes / entity DB
  "start_session", // writes a session trace at <traceFolder>/<session>.jsonl (server-computed)
  "end_session", // finalizes the same computed trace path
  // --- Runtime-computed path SET (all notes matching a query): each affected note is enforced
  //     handler-side as it is discovered; there is no input-derivable path to extract.
  "rewrite_link", // rewrites a link across every note that contains it
  // --- Bridge dispatch into a running Obsidian: the plugin performs the action; no server-side
  //     vault path is touched (any file the plugin writes is outside this process's ACL surface).
  "execute_command", // runs an Obsidian command-palette command by id
  "trigger_quickadd", // runs a QuickAdd choice inside Obsidian
  "remotely_save_trigger", // triggers a Remotely Save backup run
  // --- No vault file at all: operate on git state, a queue, or the experiential SQLite store.
  "git_commit", // commits the already-staged index; touches no vault file through the ACL surface
  "enqueue_capture", // enqueues to the capture_queue table; no vault write until commit_capture
  "work_forget", // deletion propagation within the experiential store (not authored vault notes)
  "record_retrieval_feedback", // stamps an outcome on an experiential retrieval-log row
]);

describe("THE-414 folder-ACL path-extraction coverage", () => {
  const root = mkdtempSync(join(tmpdir(), "obtc-acl-cov-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function buildRegistry(): ToolRegistry {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const vaultRegistry = new VaultRegistry([{ id: "t", name: "t", path: root }]);
    const rateLimiter = new RateLimiter(NO_THROTTLE as never);
    const registry = new ToolRegistry({ rateLimiter });
    const noop = () => {};
    const embeddingProvider: any = {
      provider: "ollama",
      model: "nomic-embed-text",
      embed: async () => [],
    };
    const metadataIndex = { hasFts: false, ready: () => true };
    const bridge: any = () => ({ client: undefined, timeoutMs: 1000 });
    registry.register(
      createHealthTool({
        version: "test",
        vaults: ["t"],
        startedAt: 0,
        nativeLoaded: false,
        vecEnabled: false,
        ftsEnabled: false,
      }),
    );
    registerM1Tools(registry, {
      vaultRegistry,
      version: "test",
      startedAt: 0,
      embeddings: { provider: "ollama", model: "nomic-embed-text" },
      metadataIndex,
      reindex: noop,
      deindex: noop,
    });
    registerM2Tools(registry, {
      vaultRegistry,
      embeddingProvider,
      dataviewBridge: bridge,
      regexTimeoutMs: 1000,
      metadataIndex,
    });
    registerM3Tools(registry, { vaultRegistry, reindex: noop, templaterBridge: bridge });
    registerM4Tools(registry, {
      reindex: noop,
      vaultRegistry,
      capabilities: (() => ({})) as never,
      bridgeFor: () => undefined,
      timeouts: (() => ({})) as never,
      commandPolicy: () => ({ enabled: false, allowlist: [] }),
      mode: () => "headless",
    });
    registerM5Tools(registry, {
      vaultRegistry,
      activeSessions: {} as never,
      reindex: noop,
      plur: {} as never,
      memoryFolder: () => "memory",
      traceFolder: () => "workspace",
    });
    registerM6Tools(registry, {
      vaultRegistry,
      rateLimiter,
      version: "test",
      startedAt: 0,
      authMode: "none",
      throttle: {} as never,
      observability: { otel: false, prometheus: false, morgiana: true },
      embeddingsProvider: "ollama",
      governorMaxResponseBytes: 1e6,
      capabilities: (() => ({})) as never,
      registeredTools: () => registry.list().length,
      reindex: noop,
      deindex: noop,
    });
    registerM7Tools(registry, {
      vaultRegistry,
      embeddingProvider,
      reranker: {} as never,
      roles: {} as never,
    });
    registerM8Tools(registry, {});
    return registry;
  }

  it("every mutating tool declares pathAcl or is a documented no-path exemption", () => {
    const registry = buildRegistry();
    const mutating = registry
      .list()
      .filter((d) => d.destructive === true || d.requiredScopes.some(isMutatingScope));
    const offenders = mutating
      .filter((d) => !d.pathAcl && !EXEMPT_NO_PATH.has(d.name))
      .map((d) => d.name)
      .sort();
    expect(
      offenders,
      `mutating tools missing pathAcl (annotate or exempt): ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("EXEMPT_NO_PATH lists no tool that also declares pathAcl (would be contradictory)", () => {
    const registry = buildRegistry();
    const byName = new Map(registry.list().map((d) => [d.name, d]));
    for (const name of EXEMPT_NO_PATH) {
      const def = byName.get(name);
      expect(def, `exempt tool not registered: ${name}`).toBeDefined();
      expect(def?.pathAcl, `${name} is both exempt and declares pathAcl`).toBeUndefined();
    }
  });
});

// Proves the CENTRAL gate actually enforces — independent of any handler. The synthetic tool's
// handler deliberately does NOT call enforcePathAcl, so a denial can only come from runDispatch's
// def.pathAcl stage. (The per-vault-acl / acl-* suites don't wire rootResolver, so they exercise
// only the handler-side defense-in-depth; this is the missing coverage.)
describe("THE-414 central pathAcl enforcement (handler does not gate)", () => {
  const stubDb = {
    prepare() {
      throw new Error("no db in this unit test");
    },
  } as unknown as Database;

  function setup(root: string) {
    const acl = new FolderAcl({
      readOnly: false,
      defaultScopes: [],
      rules: [],
      writePaths: ["allowed/**"],
    });
    const registry = new ToolRegistry({ rootResolver: () => root });
    registry.register({
      name: "synthetic_write",
      description: "test-only: declares pathAcl(write) but its handler never calls enforcePathAcl",
      inputSchema: z.object({ vault: z.string(), path: z.string() }),
      requiredScopes: ["write:notes"],
      pathAcl: (input: { path: string }) => [{ op: "write" as const, path: input.path }],
      handler: () => ({ ok: true }),
    } as any);
    const ctx = (): CallerContext => ({
      caller: "t",
      authenticated: true,
      grantedScopes: new Set(["*"]),
      vaultId: "v",
      db: stubDb,
      acl,
    });
    return (path: string) => registry.dispatch("synthetic_write", { vault: "v", path }, ctx());
  }

  it("denies a write outside the whitelist even though the handler never checks", async () => {
    const root = mkdtempSync(join(tmpdir(), "obtc-central-"));
    try {
      const call = setup(root);
      const denied = await call("outside.md");
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error.code).toBe("acl_denied");
      const allowed = await call("allowed/in.md");
      expect(allowed.ok).toBe(true); // no over-denial on an in-whitelist path
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
