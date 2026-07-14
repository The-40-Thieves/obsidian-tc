// THE-291 3B — searchTextIndexed parity vs the disk scan.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import type { EmbeddingProvider } from "../src/embeddings";
import { ensureNotesFts } from "../src/search/fts";
import { indexVault } from "../src/search/indexer";
import { searchText, searchTextIndexed, type TextOptions } from "../src/search/text";
import { openMemoryDb } from "./helpers";

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
  "a.md": "# Notes\n\nthe notebook is on the desk\nBook club meets today\n",
  "sub/b.md": "casebook and BOOK and book\n",
  "c.md": "nothing relevant here\n",
  "denied.md": "secret book stash\n",
};

async function harness(): Promise<{
  db: Database;
  root: string;
  hasFts: boolean;
  cleanup: () => void;
}> {
  const db = openMemoryDb();
  provisionCacheDb(db);
  runMigrations(db, [{ version: "20260702_001", sql: notesSql }], { version: "test" });
  const hasFts = ensureNotesFts(db);
  const root = mkdtempSync(join(tmpdir(), "obtc-3b-"));
  for (const [rel, content] of Object.entries(FILES)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  await indexVault({ db, provider, vaultId: "v1", root, isReadable: () => true, now: Date.now });
  return { db, root, hasFts, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function keyset(hits: Array<{ path: string; line: number; col: number }>): string[] {
  return hits.map((h) => `${h.path}:${h.line}:${h.col}`).sort();
}

describe("searchTextIndexed parity (THE-291 3B)", () => {
  it("matches the disk scan's hit set across query shapes; short queries signal fallback", async () => {
    const h = await harness();
    try {
      if (!h.hasFts) return; // adapter without FTS5 — the gate keeps the disk path; nothing to compare
      const cases: TextOptions[] = [
        { query: "book", limit: 100 },
        { query: "book", wholeWord: true, limit: 100 },
        { query: "BOOK", caseSensitive: true, limit: 100 },
        { query: "book", sub: "sub", limit: 100 },
        { query: "notebook", limit: 100 },
      ];
      for (const opts of cases) {
        const indexed = searchTextIndexed(h.db, "v1", h.root, opts);
        expect(indexed, JSON.stringify(opts)).not.toBeNull();
        const disk = searchText(h.root, opts);
        expect(keyset(indexed ?? []), JSON.stringify(opts)).toEqual(keyset(disk));
      }
      // Sub-trigram query -> null (disk fallback signal).
      expect(searchTextIndexed(h.db, "v1", h.root, { query: "bo", limit: 10 })).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  it("ACL-filters candidates at query time", async () => {
    const h = await harness();
    try {
      if (!h.hasFts) return;
      const readable = (p: string): boolean => p !== "denied.md";
      const indexed = searchTextIndexed(h.db, "v1", h.root, {
        query: "book",
        isReadable: readable,
        limit: 100,
      });
      expect(indexed).not.toBeNull();
      expect((indexed ?? []).some((x) => x.path === "denied.md")).toBe(false);
      const disk = searchText(h.root, { query: "book", isReadable: readable, limit: 100 });
      expect(keyset(indexed ?? [])).toEqual(keyset(disk));
    } finally {
      h.cleanup();
    }
  });
});
