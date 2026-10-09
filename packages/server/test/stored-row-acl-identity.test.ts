// A stored name is authorized on its ACL identity (chunks.acl_path / notes.acl_path), and a name that
// has NO current identity is unresolved, not "its own". Three holes this pins:
//   * note_quality_report returned the whole rollup, private rows and counts included;
//   * a derived record (gap nearest hit, quality row) that outlived the chunks/notes rows of a
//     removed symlink alias was read as its own identity, so a `wiki/**` caller saw the stale
//     private path;
//   * chunks and notes naming different identities for one path were resolved by whichever came first.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { runMigrations } from "../src/db/migrate";
import { EXPERIENTIAL_MIGRATION_FILES, versionOf } from "../src/db/migration-manifest";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { persistGapReport } from "../src/experiential/gaps";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { registerM8Tools } from "../src/tools/m8";
import { readableRel } from "../src/vault/acl-read-filter";
import { readableStoredRow } from "../src/vault/stored-acl-path";
import { openMemoryDb } from "./helpers";
import { makeWikiHarness, type WikiHarness } from "./wiki-test-helpers";

const NOW = 1_700_000_000_000;
const SCOPES = new Set(["read:notes"]);
const acl = (readPaths: string[]): FolderAcl =>
  new FolderAcl({ readOnly: false, defaultScopes: [], rules: [], readPaths });

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${name}`, import.meta.url)), "utf8");
function edb0(): Database {
  const db = openMemoryDb();
  runMigrations(
    db,
    EXPERIENTIAL_MIGRATION_FILES.map((f) => ({ version: versionOf(f), sql: read(f) })),
  );
  return db;
}

function cacheDb(): Database {
  const db = openMemoryDb();
  provisionCacheDb(db);
  return db;
}

let n = 0;
function chunk(db: Database, vault: string, path: string, aclPath: string | null): void {
  db.prepare(
    `INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at, acl_path)
     VALUES (?, ?, ?, 0, '[]', 'x', ?, 1, 0, 0, ?)`,
  ).run(`c${++n}`, vault, path, `h${n}`, aclPath);
}

function note(db: Database, vault: string, path: string, aclPath: string | null): void {
  db.prepare(
    `INSERT INTO notes (vault_id, path, title, tags, content_hash, mtime, size, indexed_at, acl_path)
     VALUES (?, ?, ?, '[]', ?, 0, 1, 0, ?)`,
  ).run(vault, path, path, `n${++n}`, aclPath);
}

function quality(db: Database, vault: string, path: string, flags = "[]"): void {
  db.prepare(
    "INSERT INTO note_quality (vault_id, path, computed_at, flags, quality_score) VALUES (?, ?, ?, ?, 0.5)",
  ).run(vault, path, NOW, flags);
}

function m8(edb: Database, cache: Database) {
  const registry = new ToolRegistry({});
  registerM8Tools(registry, { edb, now: () => NOW });
  const call = async (tool: string, input: Record<string, unknown>, a?: FolderAcl) => {
    const ctx: CallerContext = {
      caller: "tester",
      authenticated: true,
      grantedScopes: SCOPES,
      vaultId: "main",
      db: cache,
      ...(a ? { acl: a } : {}),
    };
    return (await registry.dispatch(tool, input, ctx)) as unknown as { data: any };
  };
  return { call };
}

describe("note_quality_report is filtered by the caller's read ACL", () => {
  it("a restricted principal gets no private row, and the count does not reveal one", async () => {
    const edb = edb0();
    const cache = cacheDb();
    for (const p of ["public/a.md", "public/b.md", "private/secret-project.md"]) {
      chunk(cache, "main", p, p);
      quality(edb, "main", p);
    }
    // a symlink alias: shown as wiki/..., authorized as the private target
    chunk(cache, "main", "wiki/alias.md", "private/alias.md");
    quality(edb, "main", "wiki/alias.md");
    const { call } = m8(edb, cache);

    const res = (
      await call("note_quality_report", { vault: "main" }, acl(["public/**", "wiki/**"]))
    ).data;
    expect(res.notes.map((r: { path: string }) => r.path).sort()).toEqual([
      "public/a.md",
      "public/b.md",
    ]);
    expect(res.count).toBe(2);
    expect(JSON.stringify(res)).not.toContain("private/");
    expect(JSON.stringify(res)).not.toContain("alias");

    const all = (await call("note_quality_report", { vault: "main" })).data;
    expect(all.count).toBe(4);
  });

  it("the limit is spent on rows the caller can read", async () => {
    const edb = edb0();
    const cache = cacheDb();
    for (const p of ["a-private/1.md", "a-private/2.md", "public/z.md"]) {
      chunk(cache, "main", p, p);
      quality(edb, "main", p);
    }
    const { call } = m8(edb, cache);
    const res = (await call("note_quality_report", { vault: "main", limit: 1 }, acl(["public/**"])))
      .data;
    expect(res.notes.map((r: { path: string }) => r.path)).toEqual(["public/z.md"]);
  });
});

describe("a path with no current chunks/notes identity is hidden", () => {
  it("gap_report drops a nearest hit whose alias rows are gone", async () => {
    const edb = edb0();
    const cache = cacheDb();
    chunk(cache, "main", "wiki/live.md", "wiki/live.md");
    persistGapReport(
      edb,
      {
        threshold: 0.2,
        min_results: 1,
        total: 1,
        gaps: 0,
        gap_rate: 0,
        items: [
          {
            id: "q1",
            query: "q",
            top_score: 0.9,
            results: 2,
            gap: false,
            nearest: [
              { path: "wiki/secret.md", score: 0.9 },
              { path: "wiki/live.md", score: 0.5 },
            ],
          },
        ],
      },
      { vaultId: "main", computedAt: 1 },
    );
    const { call } = m8(edb, cache);
    const res = (await call("gap_report", { vault: "main" }, acl(["wiki/**"]))).data;
    expect(res.items[0].nearest.map((x: { path: string }) => x.path)).toEqual(["wiki/live.md"]);
    expect(JSON.stringify(res)).not.toContain("secret");
  });

  describe("lint_wiki", () => {
    let h: WikiHarness;
    afterEach(() => h?.v.cleanup());

    it("proposes nothing about a stale quality row or gap hit whose alias rows are gone", async () => {
      const edb = edb0();
      h = makeWikiHarness({
        files: { "wiki/Live.md": "---\nsources: [x]\n---\nlive\n" },
        acl: { readPaths: ["wiki/**"] },
        edb,
      });
      h.seed("wiki/Live.md", [1, 0, 0, 0]);
      h.v.db.exec("UPDATE chunks SET acl_path = path WHERE acl_path IS NULL");
      quality(edb, "test", "wiki/Live.md", '["stale_edit"]');
      quality(edb, "test", "wiki/secret.md", '["stale_edit"]');
      persistGapReport(
        edb,
        {
          threshold: 0.2,
          min_results: 1,
          total: 1,
          gaps: 1,
          gap_rate: 1,
          items: [
            {
              id: "g1",
              query: "tides",
              top_score: 0.05,
              results: 2,
              gap: true,
              nearest: [
                { path: "wiki/secret.md", score: 0.05 },
                { path: "wiki/Live.md", score: 0.04 },
              ],
            },
          ],
        },
        { vaultId: "test", computedAt: 1 },
      );
      const d = await h.data("lint_wiki", { checks: ["quality", "coverage_gaps"] });
      const stale = (d.proposals as Array<{ kind: string; subject: string }>).filter(
        (p) => p.kind === "stale",
      );
      expect(stale.map((p) => p.subject)).toEqual(["wiki/Live.md"]);
      expect(JSON.stringify(d)).not.toContain("secret");
      expect(JSON.stringify(d)).toContain("wiki/Live.md");
    });
  });
});

describe("readableStoredRow fails closed on a missing or contradictory identity", () => {
  const allow = (a: FolderAcl) => (rel: string) => readableRel(a, rel, SCOPES);

  it("chunks and notes naming different identities for one path: hidden", () => {
    const db = cacheDb();
    chunk(db, "v", "wiki/x.md", "wiki/x.md");
    note(db, "v", "wiki/x.md", "pages/x.md");
    // the agreeing pair is the positive control
    chunk(db, "v", "wiki/ok.md", "wiki/ok.md");
    note(db, "v", "wiki/ok.md", "wiki/ok.md");
    const readable = readableStoredRow(db, "v", allow(acl(["wiki/**", "pages/**"])));
    expect(readable("wiki/x.md")).toBe(false);
    expect(readable("wiki/ok.md")).toBe(true);
    // and the other way round: self on the notes side, alias on the chunks side
    const db2 = cacheDb();
    chunk(db2, "v", "wiki/y.md", "pages/y.md");
    note(db2, "v", "wiki/y.md", "wiki/y.md");
    expect(readableStoredRow(db2, "v", allow(acl(["wiki/**", "pages/**"])))("wiki/y.md")).toBe(
      false,
    );
  });

  it("a path in neither table is unresolved, not its own identity", () => {
    const db = cacheDb();
    note(db, "v", "wiki/here.md", "wiki/here.md");
    const readable = readableStoredRow(db, "v", allow(acl(["wiki/**"])));
    expect(readable("wiki/here.md")).toBe(true);
    expect(readable("wiki/gone.md")).toBe(false);
    // another vault's row is not this vault's identity
    chunk(db, "other", "wiki/gone.md", "wiki/gone.md");
    expect(readableStoredRow(db, "v", allow(acl(["wiki/**"])))("wiki/gone.md")).toBe(false);
  });

  it("a connection with no acl_path column keeps the old rule: every row is its own identity", () => {
    const db = openMemoryDb();
    expect(readableStoredRow(db, "v", allow(acl(["wiki/**"])))("wiki/any.md")).toBe(true);
  });
});
