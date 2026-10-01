// Write-provenance coverage: EVERY mutating tool in the real registry emits exactly one record.
//
// The set is derived from the registry (the same `isMutatingCall` predicate dispatch gates on), not
// a hand list, so a mutating tool added tomorrow is covered the day it registers, and one that could
// dodge the dispatch hook would fail here. Each tool is dispatched through a probe registry with its
// real definition (name, scopes, destructive flag, HITL declaration) but a stub handler that writes
// one file, so the record's before/after digests are exercised too.
//
// Assembly mirrors acl-extraction-coverage.test.ts: registration only builds definitions, so cheap
// stubs suffice.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { provisionCacheDb } from "../src/db/provision";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { isMutatingCall } from "../src/mcp/registry/policy-gates";
import { buildRepresentationManifest } from "../src/search/representation";
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
import { provenanceFixture, rowsFor } from "./provenance-helpers";
import { rmTemp } from "./tmp";

const NO_THROTTLE = {
  read: { perMinute: 1e6, burst: 1e6 },
  write: { perMinute: 1e6, burst: 1e6 },
  bulk: { perMinute: 1e6, burst: 1e6 },
  execute: { perMinute: 1e6, burst: 1e6 },
  admin: { perMinute: 1e6, burst: 1e6 },
};

const root = mkdtempSync(join(tmpdir(), "obtc-prov-cov-"));
afterAll(() => rmTemp(root));

function buildRealRegistry(): ToolRegistry {
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
    representation: buildRepresentationManifest(embeddingProvider, {}),
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
    cacheDir: "",
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

describe("write provenance coverage", () => {
  const real = buildRealRegistry();
  const mutating = real.list().filter((d) => isMutatingCall(d));

  it("the registry exposes a real, non-trivial mutating set to cover", () => {
    // An existence floor: a derivation that silently found nothing would pass the loop below.
    expect(mutating.length).toBeGreaterThan(40);
    const names = mutating.map((d) => d.name);
    for (const expected of ["write_note", "move_note", "delete_note", "bulk_move_notes"]) {
      expect(names, `${expected} should be a mutating tool`).toContain(expected);
    }
  });

  it("every mutating tool emits exactly one record, with real before/after digests", async () => {
    const fx = await provenanceFixture();
    const failures: string[] = [];
    for (const def of mutating) {
      const probe = new ToolRegistry({
        provenance: fx.recorder,
        rootResolver: () => root,
        verifyElicit: () => true,
      });
      const target = `probe-${def.name}.md`;
      probe.register({
        ...def,
        inputSchema: z.any(),
        outputSchema: undefined,
        tags: undefined,
        precheck: undefined,
        resolvePolicy: undefined,
        resolveTarget: undefined,
        deniedItems: undefined,
        pathAcl: () => [{ op: "write" as const, path: target }],
        handler: async () => {
          writeFileSync(join(root, target), `content written by ${def.name}`);
          return { ok: true };
        },
      } as never);
      const ctx: CallerContext = {
        caller: "coverage",
        authenticated: true,
        grantedScopes: new Set(["*"]),
        vaultId: "t",
        db: fx.db,
        elicitToken: "x",
      };
      const before = rowsFor(fx.db).length;
      const res = await probe.dispatch(def.name, { vault: "t" }, ctx);
      const added = rowsFor(fx.db).slice(before);
      if (!res.ok) {
        failures.push(`${def.name}: probe dispatch failed: ${res.error.code} ${res.error.message}`);
        continue;
      }
      if (added.length !== 1) {
        failures.push(`${def.name}: expected exactly 1 provenance record, got ${added.length}`);
        continue;
      }
      const body = JSON.parse((added[0] as { body: string }).body);
      if (body.tool !== def.name) failures.push(`${def.name}: record names ${body.tool}`);
      const p = body.paths[0];
      if (p?.before !== "absent" || !/^[0-9a-f]{64}$/.test(p?.after ?? "")) {
        failures.push(`${def.name}: digests not captured: ${JSON.stringify(p)}`);
      }
      rmSync(join(root, target), { force: true });
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("read-only tools emit nothing", async () => {
    const fx = await provenanceFixture();
    const probe = new ToolRegistry({ provenance: fx.recorder, rootResolver: () => root });
    const readDef = real.list().find((d) => d.name === "read_note");
    expect(readDef).toBeDefined();
    probe.register({
      ...readDef,
      tags: undefined,
      inputSchema: z.any(),
      outputSchema: undefined,
      handler: async () => ({}),
    } as never);
    const res = await probe.dispatch(
      "read_note",
      { vault: "t", path: "a.md" },
      { caller: "c", authenticated: true, grantedScopes: new Set(["*"]), vaultId: "t", db: fx.db },
    );
    expect(res.ok).toBe(true);
    expect(rowsFor(fx.db)).toHaveLength(0);
  });
});
