// Harness for `obsidian-tc memory import` tests: a real temp vault + a real temp import-source
// directory, an in-memory cache DB on the committed schema, M1 + M5 registered on one
// ToolRegistry (the same pair cli/commands/memory-import.ts wires), and a bound `dispatch`
// closure matching memory-import/apply.ts's Dispatch type. Mirrors m5-helpers.ts's makeM5Vault.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import type { CallerContext } from "../src/mcp/registry";
import { ToolRegistry } from "../src/mcp/registry";
import type { Dispatch } from "../src/memory-import/apply";
import { registerM1Tools } from "../src/tools/m1";
import { registerM5Tools } from "../src/tools/m5";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";
import { rmTemp } from "./tmp";

export interface MemoryImportHarness {
  vaultRoot: string;
  importRoot: string;
  db: Database;
  dispatch: Dispatch;
  read(rel: string): string;
  exists(rel: string): boolean;
  writeImportFile(rel: string, content: string): void;
  cleanup(): void;
}

export function makeMemoryImportHarness(vaultId = "test"): MemoryImportHarness {
  const vaultRoot = mkdtempSync(join(tmpdir(), "obtc-memimport-vault-"));
  const importRoot = mkdtempSync(join(tmpdir(), "obtc-memimport-src-"));
  // Review finding: this dir used to be created and never removed (mkdtempSync leak) — every
  // test run left one more empty `obtc-memimport-cache-*` directory behind in the OS temp dir.
  const cacheDir = mkdtempSync(join(tmpdir(), "obtc-memimport-cache-"));
  const db = openMemoryDb();
  provisionCacheDb(db);
  const vaultRegistry = new VaultRegistry([{ id: vaultId, path: vaultRoot }]);
  const registry = new ToolRegistry({});
  registerM1Tools(registry, {
    vaultRegistry,
    version: "0.0.0-test",
    startedAt: Date.now(),
    embeddings: { provider: "module", model: "test" },
  });
  registerM5Tools(registry, {
    vaultRegistry,
    cacheDir,
    memoryFolder: () => "memory",
  });
  const ctx: CallerContext = {
    caller: "test",
    authenticated: true,
    grantedScopes: new Set(["read:memory", "write:memory", "read:notes", "write:notes"]),
    vaultId,
    db,
  };
  const writeImportFile = (rel: string, content: string): void => {
    const abs = join(importRoot, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  return {
    vaultRoot,
    importRoot,
    db,
    dispatch: (name, input) => registry.dispatch(name, input, ctx),
    read: (rel) => readFileSync(join(vaultRoot, rel), "utf8"),
    exists: (rel) => existsSync(join(vaultRoot, rel)),
    writeImportFile,
    cleanup: () => {
      rmTemp(vaultRoot);
      rmTemp(importRoot);
      rmTemp(cacheDir);
    },
  };
}
