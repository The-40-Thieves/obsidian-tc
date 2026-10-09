// vault_context bootstrap mode (no `query`) reads memory/_next-session.md and feeds up to 600 chars
// of it into retrieval. That path is ACL-checked on its canonical path, but a HARD LINK is a second
// directory entry for the same inode: realpath cannot see it, so a readable `memory/_next-session.md`
// that is a hard link to an ACL-denied private note passed the check and served the private note's
// text. The read must go through the opened-fd guard `read_note` uses (readNote), never a raw
// readFileSync on a vault path. Runs in the native-loaded CI step too (the native safe-open and the
// JS fallback refuse a hard link by different code).

import { linkSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { ensureChunkFts } from "../src/search/chunk_fts";
import { floatBlob } from "../src/search/vec";
import { registerM7Tools } from "../src/tools/m7";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

const VAULT = "main";
const CANARY = "kvantorixsecretcanary";
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmTemp(r);
});

// Readable: memory/** and public/**. private/** is outside the read whitelist.
const restrictedAcl = () =>
  new FolderAcl({
    readOnly: false,
    defaultScopes: ["read:notes"],
    rules: [],
    readPaths: ["memory/**", "public/**"],
  });

function vault(): string {
  const root = makeTempDir("obtc-vc-hl-");
  roots.push(root);
  for (const d of ["memory", "private", "public"]) mkdirSync(join(root, d), { recursive: true });
  return root;
}

function harness(root: string) {
  const db = openMemoryDb();
  provisionCacheDb(db);
  // A readable chunk that carries the canary: if the secret ever became the retrieval query, this
  // chunk is what it would surface, so its absence proves the secret never reached retrieval.
  db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at, acl_path) VALUES ('c1', ?, 'public/x.md', '0', '[]', ?, 'h1', 5, 0, 0, 'public/x.md')",
  ).run(VAULT, `${CANARY} surfaced`);
  db.prepare(
    "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES ('c1', 'test:fixed', 4, ?, 1, 0)",
  ).run(floatBlob([1, 0, 0, 0]));
  if (!ensureChunkFts(db)) throw new Error("FTS5 unavailable; refusing to pass vacuously");
  const acl = restrictedAcl();
  const registry = new ToolRegistry({ aclResolver: () => acl });
  registerM7Tools(registry, {
    vaultRegistry: new VaultRegistry([{ id: VAULT, name: VAULT, path: root }]),
    embeddingProvider: {
      id: "test:fixed",
      provider: "fake",
      model: "fixed",
      dimensions: 4,
      embed: async (texts: string[]) => texts.map(() => [1, 0, 0, 0]),
    } as never,
    reranker: null,
    roles: null,
    classRouter: false,
    acl,
  });
  const ctx: CallerContext = {
    caller: "tester",
    authenticated: true,
    grantedScopes: new Set(["read:notes"]),
    vaultId: VAULT,
    db,
    acl,
  };
  return { registry, ctx };
}

describe("vault_context bootstrap note read is hard-link safe", () => {
  it("refuses a _next-session.md that is a hard link to an ACL-denied note", async () => {
    const root = vault();
    writeFileSync(join(root, "private", "secret.md"), `${CANARY} private thread`);
    linkSync(join(root, "private", "secret.md"), join(root, "memory", "_next-session.md"));
    const { registry, ctx } = harness(root);
    const res = await registry.dispatch("vault_context", { vault: VAULT }, ctx);
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).not.toContain(CANARY);
    expect(JSON.stringify(res)).not.toContain("public/x.md");
  });

  it("still uses a normal readable bootstrap note", async () => {
    const root = vault();
    writeFileSync(
      join(root, "memory", "_next-session.md"),
      `---\ntags: [t]\n---\n${CANARY} thread`,
    );
    const { registry, ctx } = harness(root);
    const res = await registry.dispatch("vault_context", { vault: VAULT }, ctx);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const data = res.data as {
      query_source: string;
      signal?: string;
      notes: Array<{ path: string }>;
    };
    expect(data.query_source).toBe("next_session");
    expect(data.signal).toBe("memory/_next-session.md");
    expect(data.notes.map((n) => n.path)).toContain("public/x.md");
  });
});
