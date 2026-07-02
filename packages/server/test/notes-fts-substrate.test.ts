// THE-291 part 3A — notes metadata + FTS substrate.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import type { EmbeddingProvider } from "../src/embeddings";
import { ensureNotesFts, hasNotesTable } from "../src/search/fts";
import { deindexNote, indexNote, indexVault } from "../src/search/indexer";
import { openMemoryDb } from "./helpers";

const schemaSql = readFileSync(
  fileURLToPath(new URL("../src/schema.sql", import.meta.url)),
  "utf8",
);
const notesSql = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260702_001_notes.sql", import.meta.url)),
  "utf8",
);

function freshDb(): Database {
  const db = openMemoryDb();
  db.exec(schemaSql);
  runMigrations(db, [{ version: "20260702_001", sql: notesSql }], { version: "test" });
  return db;
}

let embeds = 0;
const provider: EmbeddingProvider = {
  id: "fake",
  dimensions: 3,
  embed: async (xs: string[]) => {
    embeds += xs.length;
    return xs.map(() => [1, 0, 0]);
  },
} as unknown as EmbeddingProvider;

function tmpVault(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "obtc-291b-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

const args = (db: Database, root: string, over: Record<string, unknown> = {}) => ({
  db,
  provider,
  vaultId: "v1",
  root,
  isReadable: () => true,
  now: Date.now,
  ...over,
});

describe("notes metadata + FTS substrate (THE-291 3A)", () => {
  it("indexVault writes notes rows (and fts rows when available); backfill needs no embeds", async () => {
    const db = freshDb();
    expect(hasNotesTable(db)).toBe(true);
    const hasFts = ensureNotesFts(db);
    const root = tmpVault({
      "a.md": "---\ntitle: Alpha\ntags: [x]\n---\nhello world content\n",
      "sub/b.md": "plain body\n",
    });
    try {
      const stats = await indexVault(args(db, root));
      expect(stats.notes_upserted).toBe(2);
      const rows = db.prepare("SELECT path, title, tags FROM notes ORDER BY path").all() as Array<{
        path: string;
        title: string;
        tags: string;
      }>;
      expect(rows.map((r) => r.path)).toEqual(["a.md", "sub/b.md"]);
      expect(rows[0]?.title).toBe("Alpha");
      expect(JSON.parse(rows[0]?.tags ?? "[]")).toContain("x");
      expect(rows[1]?.title).toBe("b");
      if (hasFts) {
        const n = (db.prepare("SELECT COUNT(*) AS n FROM notes_fts").get() as { n: number }).n;
        expect(n).toBe(2);
      }
      // Backfill: delete one notes row (chunks intact) — reconcile restores it with ZERO embeds.
      db.prepare("DELETE FROM notes WHERE path = ?").run("a.md");
      if (hasFts) db.prepare("DELETE FROM notes_fts WHERE path = ?").run("a.md");
      embeds = 0;
      const again = await indexVault(args(db, root));
      expect(embeds).toBe(0);
      expect(again.notes_upserted).toBe(1);
      expect(db.prepare("SELECT COUNT(*) AS n FROM notes WHERE path = 'a.md'").get()).toMatchObject(
        { n: 1 },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stale-path sweep runs only unscoped and never on folder-scoped runs", async () => {
    const db = freshDb();
    const root = tmpVault({ "keep.md": "keep\n", "gone.md": "gone\n", "sub/c.md": "c\n" });
    try {
      await indexVault(args(db, root));
      unlinkSync(join(root, "gone.md"));
      // Scoped run must NOT sweep gone.md (outside its subtree view).
      await indexVault(args(db, root, { sub: "sub" }));
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM notes WHERE path = 'gone.md'").get(),
      ).toMatchObject({ n: 1 });
      // Unscoped run sweeps it (notes + chunks).
      const stats = await indexVault(args(db, root));
      expect(stats.notes_deleted).toBe(1);
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM notes WHERE path = 'gone.md'").get(),
      ).toMatchObject({ n: 0 });
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE path = 'gone.md'").get(),
      ).toMatchObject({ n: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("secret-flagged chunk contents are excised from the FTS copy", async () => {
    const db = freshDb();
    const hasFts = ensureNotesFts(db);
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const root = tmpVault({
      "s.md": `# Intro

safe intro paragraph

# Creds

aws key ${secret} lives here

# Outro

safe outro paragraph
`,
    });
    try {
      await indexVault(args(db, root));
      if (hasFts) {
        const hit = db
          .prepare("SELECT COUNT(*) AS n FROM notes_fts WHERE notes_fts MATCH ?")
          .get(`"${secret}"`) as { n: number };
        expect(hit.n).toBe(0);
        const safe = db
          .prepare("SELECT COUNT(*) AS n FROM notes_fts WHERE notes_fts MATCH ?")
          .get('"safe intro"') as { n: number };
        expect(safe.n).toBe(1);
      }
      // The chunk store never held it either (existing secret gate).
      const c = db
        .prepare("SELECT COUNT(*) AS n FROM chunks WHERE content LIKE ?")
        .get(`%${secret}%`) as { n: number };
      expect(c.n).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("indexNote upserts the notes row on write; deindexNote clears everything", async () => {
    const db = freshDb();
    const hasFts = ensureNotesFts(db);
    await indexNote(db, provider, "v1", "w.md", "written body\n", false, Date.now);
    expect(db.prepare("SELECT COUNT(*) AS n FROM notes WHERE path='w.md'").get()).toMatchObject({
      n: 1,
    });
    deindexNote(db, "v1", "w.md", false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM notes WHERE path='w.md'").get()).toMatchObject({
      n: 0,
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE path='w.md'").get()).toMatchObject({
      n: 0,
    });
    if (hasFts) {
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM notes_fts WHERE path='w.md'").get(),
      ).toMatchObject({ n: 0 });
    }
  });

  it("onNotesPass fires even when the embed pass fails (readiness decoupled)", async () => {
    const db = freshDb();
    const bad: EmbeddingProvider = {
      id: "bad",
      dimensions: 3,
      embed: async () => {
        throw new Error("backend offline");
      },
    } as unknown as EmbeddingProvider;
    const root = tmpVault({ "n.md": "needs embedding\n" });
    try {
      let notesPass = false;
      await expect(
        indexVault(args(db, root, { provider: bad, onNotesPass: () => (notesPass = true) })),
      ).rejects.toThrow();
      expect(notesPass).toBe(true);
      expect(db.prepare("SELECT COUNT(*) AS n FROM notes").get()).toMatchObject({ n: 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
