// THE-602 wave 2: closes genuinely-reachable uncovered branches in registry-tools.ts (the
// list_vaults/get_vault/reload_vault/reset_vault_cache handlers). Every test here asserts a real
// returned value or error code produced by exercising an actual caller-visible code path — no
// branch is forced by mocking away the thing being tested.
//
// A handful of the branches on the starting map (countRows' table-allowlist throw at line 24, and
// the `??`/ternary fallbacks in countRows/dbSizeBytes at lines 30, 40, 41) are NOT exercised here.
// They are dead code from the public tool surface: countRows is only ever called internally with
// the literal "chunks", and COUNT(*)/PRAGMA page_count/PRAGMA page_size always return exactly one
// row with a defined numeric column under real SQLite semantics, so their `?? 0` / ternary
// fallback legs cannot fire without fabricating a non-conforming db driver — that would be
// coverage theater, not a real test. See the final report for detail.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { elicitVerifier, issueElicitToken } from "../src/elicit";
import { argsHash } from "../src/hash";
import type { CallerContext } from "../src/mcp/registry";
import { ToolRegistry } from "../src/mcp/registry";
import type { M1Deps } from "../src/tools/m1";
import { registerM1Tools } from "../src/tools/m1";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";
import { makeTestVault } from "./m1-helpers";
import { rmTemp } from "./tmp";

// A second, lower-level harness (mirrors m1-helpers' makeTestVault) that accepts arbitrary M1Deps
// overrides — configPath / indexVault are baked into the registry at construction time in the
// real code, so they cannot be exercised through makeTestVault's fixed dep set.
function makeCustomVault(deps: Partial<M1Deps> = {}) {
  const root = mkdtempSync(join(tmpdir(), "obtc-regcov-"));
  const id = deps.vaultRegistry ? undefined : "test";
  const db = openMemoryDb();
  provisionCacheDb(db);
  const vaultRegistry = deps.vaultRegistry ?? new VaultRegistry([{ id: id ?? "test", path: root }]);
  const registry = new ToolRegistry({ verifyElicit: elicitVerifier });
  registerM1Tools(registry, {
    vaultRegistry,
    version: "test",
    startedAt: 0,
    embeddings: { provider: "ollama", model: "nomic-embed-text" },
    ...deps,
  });
  const ctx = (over: Partial<CallerContext> = {}): CallerContext => ({
    caller: "test",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: id ?? "test",
    db,
    ...over,
  });
  return {
    root,
    db,
    call: (name: string, input: Record<string, unknown>, over?: Partial<CallerContext>) =>
      registry.dispatch(name, input, ctx(over)),
    cleanup: () => rmTemp(root),
  };
}

// Wraps a real Database so the two cache-stat SQL statements (countRows' chunk count and
// dbSizeBytes' PRAGMAs) fail while everything else dispatch needs (audit writes, idempotency,
// ACL) still hits the real connection. Exercises countRows/dbSizeBytes' own try/catch fallbacks —
// a genuine "cache stats degrade to 0 rather than fail the call" behavior — without touching the
// dead allowlist-throw / numeric-fallback branches described above.
function makeStatsFaultyDb(base: Database): Database {
  const boom = () => {
    throw new Error("simulated cache-stats failure");
  };
  return {
    exec: (sql: string) => base.exec(sql),
    prepare: (sql: string) => {
      if (sql.includes("FROM chunks WHERE vault_id") || sql.startsWith("PRAGMA page_")) {
        return { run: boom, get: boom, all: boom };
      }
      return base.prepare(sql);
    },
    close: base.close?.bind(base),
  };
}

describe("THE-602 registry-tools branch coverage", () => {
  it("list_vaults reports read_only:true under a read-only ACL (branch 10.1)", async () => {
    const v = makeTestVault({ acl: { readOnly: true } });
    try {
      const r = await v.call("list_vaults", {});
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { vaults: Array<{ read_only: boolean }> };
        expect(d.vaults[0]?.read_only).toBe(true);
      }
    } finally {
      v.cleanup();
    }
  });

  it("get_vault reports read_only:true and null acl paths with no ACL overrides (branches 11.1, 13.1)", async () => {
    const v = makeTestVault({ acl: { readOnly: true } });
    try {
      const r = await v.call("get_vault", { vault: "test" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as {
          read_only: boolean;
          acl: {
            read_paths: string[] | null;
            write_paths: string[] | null;
            delete_paths: string[] | null;
          };
        };
        expect(d.read_only).toBe(true);
        expect(d.acl.write_paths).toBeNull();
        expect(d.acl.read_paths).toBeNull();
        expect(d.acl.delete_paths).toBeNull();
      }
    } finally {
      v.cleanup();
    }
  });

  it("list_vaults/get_vault default read_only to false when the caller carries no ACL at all", async () => {
    const v = makeTestVault();
    try {
      const list = await v.call("list_vaults", {}, { acl: undefined });
      expect(list.ok).toBe(true);
      if (list.ok) {
        const d = list.data as { vaults: Array<{ read_only: boolean }> };
        expect(d.vaults[0]?.read_only).toBe(false);
      }

      const get = await v.call("get_vault", { vault: "test" }, { acl: undefined });
      expect(get.ok).toBe(true);
      if (get.ok) {
        const d = get.data as { read_only: boolean };
        expect(d.read_only).toBe(false);
      }
    } finally {
      v.cleanup();
    }
  });

  it("list_vaults/get_vault degrade cache stats to 0 instead of failing when the stats queries error (countRows/dbSizeBytes catches)", async () => {
    const v = makeTestVault();
    try {
      const faulty = makeStatsFaultyDb(v.db);
      const list = await v.call("list_vaults", {}, { db: faulty });
      expect(list.ok).toBe(true);
      if (list.ok) {
        const d = list.data as { vaults: Array<{ chunk_count: number }> };
        expect(d.vaults[0]?.chunk_count).toBe(0);
      }

      const get = await v.call("get_vault", { vault: "test" }, { db: faulty });
      expect(get.ok).toBe(true);
      if (get.ok) {
        const d = get.data as { cache: { chunk_count: number; db_size_bytes: number } };
        expect(d.cache.chunk_count).toBe(0);
        expect(d.cache.db_size_bytes).toBe(0);
      }
    } finally {
      v.cleanup();
    }
  });

  it("add_vault rejects a path that exists but is not a directory (branch 8.0)", async () => {
    const v = makeTestVault();
    const dir = mkdtempSync(join(tmpdir(), "obtc-addvault-file-"));
    const filePath = join(dir, "notadir.txt");
    writeFileSync(filePath, "just a file");
    try {
      const r = await v.call("add_vault", { vault_id: "notadir", path: filePath });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("invalid_input");
        expect(r.error.message).toMatch(/not a directory/);
      }
    } finally {
      rmTemp(dir);
      v.cleanup();
    }
  });

  it("add_vault runs deps.indexVault when provided and reports the indexer's summary (branch 9.0)", async () => {
    const seen: string[] = [];
    const harness = makeCustomVault({
      indexVault: async (vaultId: string) => {
        seen.push(vaultId);
        return { notes_seen: 3 };
      },
    });
    const dir = mkdtempSync(join(tmpdir(), "obtc-addvault-idx-"));
    try {
      const r = await harness.call("add_vault", { vault_id: "extra", path: dir });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { indexed: boolean; index: { notes_seen: number } | null };
        expect(d.indexed).toBe(true);
        expect(d.index).toEqual({ notes_seen: 3 });
      }
      expect(seen).toEqual(["extra"]);
    } finally {
      rmTemp(dir);
      harness.cleanup();
    }
  });

  it("reload_vault re-checks an on-disk config when configPath is set and the vault is still listed (branch 15.0 true)", async () => {
    const cfgDir = mkdtempSync(join(tmpdir(), "obtc-cfg-ok-"));
    const configPath = join(cfgDir, "config.json");
    const harness = makeCustomVault({ configPath });
    try {
      writeFileSync(configPath, JSON.stringify({ vaults: [{ id: "test", path: harness.root }] }));
      const r = await harness.call("reload_vault", { vault: "test" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { vault: string; reloaded_at: string };
        expect(d.vault).toBe("test");
        expect(typeof d.reloaded_at).toBe("string");
      }
    } finally {
      rmTemp(cfgDir);
      harness.cleanup();
    }
  });

  it("reload_vault reports vault_not_found when the vault was removed from the on-disk config (branch 16.0)", async () => {
    const cfgDir = mkdtempSync(join(tmpdir(), "obtc-cfg-gone-"));
    const configPath = join(cfgDir, "config.json");
    const otherDir = mkdtempSync(join(tmpdir(), "obtc-cfg-gone-other-"));
    const harness = makeCustomVault({ configPath });
    try {
      // "test" (the registered vault) is no longer in the config; only "other" is.
      writeFileSync(configPath, JSON.stringify({ vaults: [{ id: "other", path: otherDir }] }));
      const r = await harness.call("reload_vault", { vault: "test" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("vault_not_found");
    } finally {
      rmTemp(cfgDir);
      rmTemp(otherDir);
      harness.cleanup();
    }
  });

  it("reset_vault_cache drops event_log rows when include.event_log is true (branch 20.0)", async () => {
    const v = makeTestVault();
    try {
      // A prior dispatched call leaves an audited event_log row for this vault.
      await v.call("list_vaults", {});
      expect(v.events().length).toBeGreaterThan(0);

      const input = { vault: "test", include: { event_log: true } };
      const need = await v.call("reset_vault_cache", input);
      expect(need.ok).toBe(false);
      if (!need.ok) expect(need.error.code).toBe("elicit_required");

      const token = issueElicitToken(v.db, {
        vaultId: "test",
        toolName: "reset_vault_cache",
        argsHash: argsHash("reset_vault_cache", input),
        caller: "test",
      });
      const ok = await v.call("reset_vault_cache", input, { elicitToken: token });
      expect(ok.ok).toBe(true);
      if (ok.ok) {
        const d = ok.data as { rows_dropped: { event_log: number } };
        expect(d.rows_dropped.event_log).toBeGreaterThan(0);
      }
      // event_log itself was cleared by the drop above (bar whatever this very call re-logs).
      expect(v.events().length).toBeLessThan(2);
    } finally {
      v.cleanup();
    }
  });

  it("reset_vault_cache leaves chunks/embeddings/idempotency_keys untouched when include opts them out", async () => {
    const v = makeTestVault();
    try {
      v.db
        .prepare(
          "INSERT INTO idempotency_keys (vault_id, key, tool_name, args_hash, started_at, expires_at) VALUES (?,?,?,?,?,?)",
        )
        .run("test", "k1", "write_note", "h", 1, 9999999999999);

      const input = {
        vault: "test",
        include: { chunks: false, embeddings: false, idempotency_keys: false, event_log: false },
      };
      const need = await v.call("reset_vault_cache", input);
      expect(need.ok).toBe(false);
      if (!need.ok) expect(need.error.code).toBe("elicit_required");

      const token = issueElicitToken(v.db, {
        vaultId: "test",
        toolName: "reset_vault_cache",
        argsHash: argsHash("reset_vault_cache", input),
        caller: "test",
      });
      const ok = await v.call("reset_vault_cache", input, { elicitToken: token });
      expect(ok.ok).toBe(true);
      if (ok.ok) {
        const d = ok.data as {
          rows_dropped: {
            chunks: number;
            vec_chunks: number;
            embeddings: number;
            idempotency_keys: number;
            event_log: number;
          };
        };
        expect(d.rows_dropped).toEqual({
          chunks: 0,
          vec_chunks: 0,
          embeddings: 0,
          idempotency_keys: 0,
          event_log: 0,
        });
      }
      // The idempotency key inserted above really does survive (include opted it out).
      const row = v.db
        .prepare("SELECT COUNT(*) AS n FROM idempotency_keys WHERE vault_id = ?")
        .get("test") as { n: number };
      expect(row.n).toBe(1);
    } finally {
      v.cleanup();
    }
  });
});
