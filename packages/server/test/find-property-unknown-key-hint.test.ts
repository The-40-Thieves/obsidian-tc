import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { EmbeddingProvider } from "../src/embeddings";
import { indexVault } from "../src/search/indexer";
import { buildRepresentationManifest } from "../src/search/representation";
import { makeTestVault } from "./m1-helpers";

const notesSql = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260702_001_notes.sql", import.meta.url)),
  "utf8",
);
const provider = {
  id: "fake",
  dimensions: 3,
  embed: async (xs: string[]) => xs.map(() => [1, 0, 0]),
} as unknown as EmbeddingProvider;

interface FindData {
  matches: Array<{ path: string; value?: unknown }>;
  hint?: { reason: string; message: string; suggestions: string[] };
}

function dataOf(r: ToolResult): FindData {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.data as FindData;
}

/** A vault served by either path: the disk walk (no metadata index) or the notes-table index
 *  (`metadataIndex` ready, rows indexed from the same files). */
async function vaultOn(
  path: "walk" | "index",
  files: Record<string, string>,
  acl?: { readPaths: string[] },
) {
  const v = makeTestVault({
    files,
    ...(acl ? { acl } : {}),
    ...(path === "index" ? { metadataIndex: { hasFts: false, ready: () => true } } : {}),
  });
  if (path === "index") {
    runMigrations(v.db, [{ version: "20260702_001", sql: notesSql }], { version: "test" });
    await indexVault({
      db: v.db,
      provider,
      vaultId: "test",
      root: v.vaultRegistry.resolve("test").root,
      isReadable: () => true,
      now: Date.now,
      representation: buildRepresentationManifest(provider, {}),
    });
  }
  return v;
}

for (const path of ["walk", "index"] as const) {
  describe(`find_notes_by_property unknown-key hint (${path} path)`, () => {
    it("suggests the plural when only the plural key exists", async () => {
      const v = await vaultOn(path, {
        "a.md": "---\ntags: [x]\n---\n",
        "b.md": "---\ntags: [y]\n---\n",
      });
      try {
        const d = dataOf(await v.call("find_notes_by_property", { vault: "test", key: "tag" }));
        expect(d.matches).toEqual([]);
        expect(d.hint).toMatchObject({ reason: "unknown_property", suggestions: ["tags"] });
      } finally {
        v.cleanup();
      }
    });

    it("suggests a case-insensitive exact match first", async () => {
      const v = await vaultOn(path, {
        "a.md": "---\nstatus: done\n---\n",
        "b.md": "---\nstatuses: x\n---\n",
      });
      try {
        const d = dataOf(await v.call("find_notes_by_property", { vault: "test", key: "Status" }));
        expect(d.hint?.reason).toBe("unknown_property");
        expect(d.hint?.suggestions[0]).toBe("status");
      } finally {
        v.cleanup();
      }
    });

    it("gives no hint when the key exists but no value matches", async () => {
      const v = await vaultOn(path, { "a.md": "---\ntags: [x]\n---\n" });
      try {
        const r = await v.call("find_notes_by_property", {
          vault: "test",
          key: "tags",
          value: "nope",
        });
        const d = dataOf(r);
        expect(d.matches).toEqual([]);
        expect(d).not.toHaveProperty("hint");
      } finally {
        v.cleanup();
      }
    });

    it("gives no hint when the key is found", async () => {
      const v = await vaultOn(path, { "a.md": "---\nstatus: done\n---\n" });
      try {
        const d = dataOf(await v.call("find_notes_by_property", { vault: "test", key: "status" }));
        expect(d.matches.length).toBe(1);
        expect(d).not.toHaveProperty("hint");
      } finally {
        v.cleanup();
      }
    });

    it("never suggests a key that only an unreadable folder holds", async () => {
      const v = await vaultOn(
        path,
        {
          "pub/a.md": "---\nstatus: done\n---\n",
          "priv/c.md": "---\nsecret: 1\n---\n",
        },
        { readPaths: ["pub/**"] },
      );
      try {
        // "secret" is one edit from "secre": it would be suggested if the ACL did not filter it.
        const d = dataOf(await v.call("find_notes_by_property", { vault: "test", key: "secre" }));
        expect(d.matches).toEqual([]);
        expect(d.hint?.reason).toBe("unknown_property");
        expect(d.hint?.suggestions).not.toContain("secret");
      } finally {
        v.cleanup();
      }
    });

    it("nested: suggests top-level keys for the first segment only, and says so", async () => {
      const v = await vaultOn(path, { "a.md": "---\nmeta:\n  author: Ada\n---\n" });
      try {
        const d = dataOf(
          await v.call("find_notes_by_property", {
            vault: "test",
            key: "meta.authr",
            nested: true,
          }),
        );
        expect(d.matches).toEqual([]);
        expect(d.hint?.suggestions).toEqual(["meta"]);
        expect(d.hint?.message).toMatch(/first segment|top-level/);
      } finally {
        v.cleanup();
      }
    });

    it("response_format=concise keeps the hint", async () => {
      const v = await vaultOn(path, { "a.md": "---\ntags: [x]\n---\n" });
      try {
        const d = dataOf(
          await v.call("find_notes_by_property", {
            vault: "test",
            key: "tag",
            response_format: "concise",
          }),
        );
        expect(d.hint?.suggestions).toEqual(["tags"]);
      } finally {
        v.cleanup();
      }
    });
  });
}
