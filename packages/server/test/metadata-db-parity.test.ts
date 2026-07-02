// THE-291 3B-ii — metadata tools: DB-backed path parity vs the disk scan.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import type { EmbeddingProvider } from "../src/embeddings";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { indexVault } from "../src/search/indexer";
import { registerM1Tools } from "../src/tools/m1";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";

const schemaSql = readFileSync(
  fileURLToPath(new URL("../src/schema.sql", import.meta.url)),
  "utf8",
);
const notesSql = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260702_001_notes.sql", import.meta.url)),
  "utf8",
);
const provider = {
  id: "fake",
  dimensions: 3,
  embed: async (xs: string[]) => xs.map(() => [1, 0, 0]),
} as unknown as EmbeddingProvider;

const FILES: Record<string, string> = {
  "a.md": "---\ntags: [project, project/sub]\nstatus: active\nprio: 2\n---\nbody a #inline\n",
  "b.md": "---\nstatus: done\n---\nbody b #project\n",
  "sub/c.md": "---\ntags: [project]\nstatus: active\n---\nc\n",
  "plain.md": "no meta\n",
};

async function harness(withIndex: boolean) {
  const db = openMemoryDb();
  db.exec(schemaSql);
  runMigrations(db, [{ version: "20260702_001", sql: notesSql }], { version: "test" });
  const root = mkdtempSync(join(tmpdir(), "obtc-3bii-"));
  for (const [rel, content] of Object.entries(FILES)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  await indexVault({ db, provider, vaultId: "t", root, isReadable: () => true, now: Date.now });
  const registry = new ToolRegistry();
  registerM1Tools(registry, {
    vaultRegistry: new VaultRegistry([{ id: "t", path: root }]),
    version: "0.0.0",
    startedAt: 0,
    embeddings: { provider: "p", model: "m" },
    ...(withIndex ? { metadataIndex: { hasFts: false, ready: () => true } } : {}),
  });
  const ctx = (): CallerContext => ({
    caller: "t",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: "t",
    db,
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
  });
  const call = (name: string, input: Record<string, unknown>) =>
    registry.dispatch(name, input, ctx());
  return { call, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const CALLS: Array<[string, Record<string, unknown>]> = [
  ["list_tags", { vault: "t" }],
  ["list_tags", { vault: "t", folder: "sub" }],
  ["find_notes_by_tag", { vault: "t", tag: "project" }],
  ["list_properties", { vault: "t" }],
  ["find_notes_by_property", { vault: "t", key: "status", value: "active" }],
  ["find_notes_by_property", { vault: "t", key: "prio" }],
];

describe("metadata tools DB-vs-disk parity (THE-291 3B-ii)", () => {
  it("DB-backed output equals the disk-scan output for every call shape", async () => {
    const dbSide = await harness(true);
    const diskSide = await harness(false);
    try {
      for (const [name, input] of CALLS) {
        const a = await dbSide.call(name, input);
        const b = await diskSide.call(name, input);
        expect(a.ok, `${name} db ok`).toBe(true);
        expect(b.ok, `${name} disk ok`).toBe(true);
        if (a.ok && b.ok) expect(a.data, `${name} ${JSON.stringify(input)}`).toEqual(b.data);
      }
    } finally {
      dbSide.cleanup();
      diskSide.cleanup();
    }
  });
});
