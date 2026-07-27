// THE-602: branch-coverage top-up for src/tools/m1/tags-tools.ts. Every test asserts
// caller-visible behavior (a thrown error's code, a returned value, or a persisted file's
// content) — never a branch executed for its own sake. See test/tags-tools.test.ts for the
// primary behavioral suite this one supplements; test/m1-helpers.ts's makeTestVault runs the
// walkVault (disk-scan) path only, so the deps.metadataIndex.ready() branches of list_tags /
// find_notes_by_tag (querying the `notes` table instead of walking the filesystem) need a
// second, local harness that seeds that table directly — mirrors the pattern in
// test/frontmatter-tools-branch-coverage.test.ts's makeIndexedVault.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { type AclConfigT, FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { buildTagsTools } from "../src/tools/m1/tags-tools";
import { contentHash } from "../src/vault/paths";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";
import { makeTestVault } from "./m1-helpers";

function errCode(r: ToolResult): string {
  if (r.ok) throw new Error("expected an error result");
  return r.error.code;
}

function okData(r: ToolResult): unknown {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.data;
}

// Local harness for the deps.metadataIndex.ready() branches: list_tags and find_notes_by_tag
// read straight from the `notes` table instead of walking the vault when the index is "ready".
// makeTestVault never wires metadataIndex, so those branches are unreachable through it — this
// seeds the table directly with real per-row tag arrays.
interface IndexedRow {
  path: string;
  tags: string[];
}

function makeIndexedTagsVault(opts: { rows: IndexedRow[]; acl?: Partial<AclConfigT> }): {
  call: (name: string, input: Record<string, unknown>) => Promise<ToolResult>;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "obtc-tags-idx-"));
  const db: Database = openMemoryDb();
  provisionCacheDb(db);
  const insert = db.prepare(
    `INSERT INTO notes (vault_id, path, title, tags, frontmatter, content_hash, mtime, size, indexed_at)
     VALUES ('test', ?, ?, ?, NULL, ?, 0, 0, 0)`,
  );
  for (const row of opts.rows) {
    insert.run(row.path, row.path, JSON.stringify(row.tags), `h-${row.path}`);
  }
  const aclCfg: AclConfigT = { readOnly: false, defaultScopes: [], rules: [], ...opts.acl };
  const acl = new FolderAcl(aclCfg);
  const vaultRegistry = new VaultRegistry([{ id: "test", path: root }]);
  const registry = new ToolRegistry();
  for (const tool of buildTagsTools({
    vaultRegistry,
    version: "test",
    startedAt: 0,
    embeddings: { provider: "ollama", model: "nomic-embed-text" },
    metadataIndex: { hasFts: false, ready: () => true },
  })) {
    registry.register(tool);
  }
  const ctx: CallerContext = {
    caller: "test",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: "test",
    db,
    acl,
  };
  return {
    call: (name, input) => registry.dispatch(name, input, ctx),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("omitKey: only the target key is dropped, siblings survive", () => {
  it("remove_tag emptying the frontmatter tags list drops only `tags`, keeps other keys", async () => {
    const v = makeTestVault({
      files: { "a.md": "---\ntitle: Keep Me\ntags: [drop]\n---\nbody" },
    });
    try {
      const r = await v.call("remove_tag", { vault: "test", path: "a.md", tag: "drop" });
      expect((okData(r) as { removed: number }).removed).toBe(1);
      const raw = v.read("a.md");
      expect(raw).toContain("title: Keep Me");
      expect(raw).not.toMatch(/^tags:/m);
    } finally {
      v.cleanup();
    }
  });
});

describe("list_tags: disk-scan max_notes cap", () => {
  it("stops scanning once max_notes is reached", async () => {
    const v = makeTestVault({
      files: { "a.md": "#alpha", "b.md": "#bravo" },
    });
    try {
      const r = await v.call("list_tags", { vault: "test", max_notes: 1 });
      const d = okData(r) as { notes_scanned: number; tags: Array<{ tag: string }> };
      expect(d.notes_scanned).toBe(1);
      expect(d.tags).toHaveLength(1); // only the one note actually scanned contributed a tag
    } finally {
      v.cleanup();
    }
  });
});

describe("get_note_tags / add_tag / remove_tag: note-not-found", () => {
  it("get_note_tags rejects a path that does not exist", async () => {
    const v = makeTestVault({ files: { "a.md": "body" } });
    try {
      const r = await v.call("get_note_tags", { vault: "test", path: "missing.md" });
      expect(errCode(r)).toBe("note_not_found");
    } finally {
      v.cleanup();
    }
  });

  it("add_tag rejects a path that is a folder, not a note", async () => {
    const v = makeTestVault({ files: { "dir/inner.md": "body" } });
    try {
      const r = await v.call("add_tag", { vault: "test", path: "dir", tag: "x" });
      expect(errCode(r)).toBe("note_not_found");
    } finally {
      v.cleanup();
    }
  });

  it("remove_tag rejects a path that does not exist", async () => {
    const v = makeTestVault({ files: { "a.md": "body" } });
    try {
      const r = await v.call("remove_tag", { vault: "test", path: "missing.md", tag: "x" });
      expect(errCode(r)).toBe("note_not_found");
    } finally {
      v.cleanup();
    }
  });
});

describe("add_tag inline: body-separator ternary", () => {
  it("does not insert a blank line when the body already ends with a newline", async () => {
    const v = makeTestVault({ files: { "a.md": "hello\n" } });
    try {
      const r = await v.call("add_tag", {
        vault: "test",
        path: "a.md",
        tag: "flag",
        location: "inline",
      });
      expect((okData(r) as { added: boolean }).added).toBe(true);
      expect(v.read("a.md")).toBe("hello\n#flag");
    } finally {
      v.cleanup();
    }
  });

  it("appends with no leading separator when the body is empty", async () => {
    const v = makeTestVault({ files: { "a.md": "" } });
    try {
      const r = await v.call("add_tag", {
        vault: "test",
        path: "a.md",
        tag: "flag",
        location: "inline",
      });
      expect((okData(r) as { added: boolean }).added).toBe(true);
      expect(v.read("a.md")).toBe("#flag");
    } finally {
      v.cleanup();
    }
  });
});

describe("add_tag / remove_tag: fieldTags handles string-form and malformed array entries", () => {
  it("add_tag merges into a comma/space-separated string-form `tags` field", async () => {
    const v = makeTestVault({ files: { "a.md": '---\ntags: "one, two"\n---\nbody' } });
    try {
      const r = await v.call("add_tag", { vault: "test", path: "a.md", tag: "three" });
      expect((okData(r) as { added: boolean }).added).toBe(true);
      const tags = await v.call("get_note_tags", { vault: "test", path: "a.md" });
      expect((okData(tags) as { frontmatter: string[] }).frontmatter).toEqual([
        "one",
        "two",
        "three",
      ]);
    } finally {
      v.cleanup();
    }
  });

  it("add_tag drops a non-string element from a malformed `tags` array instead of throwing", async () => {
    const v = makeTestVault({ files: { "a.md": "---\ntags: [1, keep]\n---\nbody" } });
    try {
      const r = await v.call("add_tag", { vault: "test", path: "a.md", tag: "new" });
      expect((okData(r) as { added: boolean }).added).toBe(true);
      const tags = await v.call("get_note_tags", { vault: "test", path: "a.md" });
      expect((okData(tags) as { frontmatter: string[] }).frontmatter).toEqual(["keep", "new"]);
    } finally {
      v.cleanup();
    }
  });
});

describe("remove_tag: prev_hash CAS", () => {
  it("proceeds and removes the tag when prev_hash matches the current content hash", async () => {
    const v = makeTestVault({ files: { "a.md": "---\ntags: [drop]\n---\nbody" } });
    try {
      const hash = contentHash(v.read("a.md"));
      const r = await v.call("remove_tag", {
        vault: "test",
        path: "a.md",
        tag: "drop",
        prev_hash: hash,
      });
      const d = okData(r) as { removed: number; prev_hash: string };
      expect(d.removed).toBe(1);
      expect(d.prev_hash).toBe(hash);
    } finally {
      v.cleanup();
    }
  });

  it("rejects a stale prev_hash before touching the file", async () => {
    const v = makeTestVault({ files: { "a.md": "---\ntags: [drop]\n---\nbody" } });
    try {
      const before = v.read("a.md");
      const r = await v.call("remove_tag", {
        vault: "test",
        path: "a.md",
        tag: "drop",
        prev_hash: "0".repeat(64),
      });
      expect(errCode(r)).toBe("concurrent_modification");
      expect(v.read("a.md")).toBe(before); // rejected before any write
    } finally {
      v.cleanup();
    }
  });
});

describe("find_notes_by_tag: disk-scan folder filter and limit truncation", () => {
  it("restricts matches to the given folder", async () => {
    const v = makeTestVault({
      files: { "proj/a.md": "#shared", "other/b.md": "#shared" },
    });
    try {
      const r = await v.call("find_notes_by_tag", { vault: "test", tag: "shared", folder: "proj" });
      const d = okData(r) as { matches: Array<{ path: string }> };
      expect(d.matches.map((m) => m.path)).toEqual(["proj/a.md"]);
    } finally {
      v.cleanup();
    }
  });

  it("truncates once the limit is reached, order-independent of which file scans first", async () => {
    const v = makeTestVault({
      files: { "a.md": "#shared", "b.md": "#shared" },
    });
    try {
      const r = await v.call("find_notes_by_tag", { vault: "test", tag: "shared", limit: 1 });
      const d = okData(r) as {
        matches: Array<{ path: string }>;
        truncated: boolean;
        total: number;
      };
      expect(d.truncated).toBe(true);
      expect(d.matches).toHaveLength(1);
      expect(d.total).toBe(1);
    } finally {
      v.cleanup();
    }
  });
});

describe("list_tags: metadataIndex.ready() (notes-table) path", () => {
  it("filters by ACL and caps scanning at max_notes", async () => {
    const idx = makeIndexedTagsVault({
      rows: [
        { path: "pub/a.md", tags: ["shared"] },
        { path: "pub/b.md", tags: ["shared", "y"] },
        { path: "priv/c.md", tags: ["secret"] },
      ],
      acl: { readPaths: ["pub/**"] },
    });
    try {
      const r = await idx.call("list_tags", { vault: "test" });
      const d = okData(r) as { notes_scanned: number; tags: Array<{ tag: string; count: number }> };
      expect(d.notes_scanned).toBe(2);
      expect(d.tags.some((t) => t.tag === "secret")).toBe(false);
      expect(d.tags.find((t) => t.tag === "shared")?.count).toBe(2);
    } finally {
      idx.cleanup();
    }
  });

  it("stops scanning once max_notes is reached", async () => {
    const idx = makeIndexedTagsVault({
      rows: [
        { path: "a.md", tags: ["alpha"] },
        { path: "b.md", tags: ["bravo"] },
      ],
    });
    try {
      const r = await idx.call("list_tags", { vault: "test", max_notes: 1 });
      const d = okData(r) as { notes_scanned: number; tags: Array<{ tag: string }> };
      expect(d.notes_scanned).toBe(1);
      expect(d.tags).toHaveLength(1);
    } finally {
      idx.cleanup();
    }
  });
});

describe("find_notes_by_tag: metadataIndex.ready() (notes-table) path", () => {
  it("folder filter: exact-match and prefix-match rows pass, unrelated rows are skipped", async () => {
    const idx = makeIndexedTagsVault({
      rows: [
        { path: "proj", tags: ["shared"] }, // r.path === sub exactly
        { path: "proj/x.md", tags: ["shared"] }, // r.path startsWith `${sub}/`
        { path: "other/y.md", tags: ["shared"] }, // neither -> skipped
      ],
    });
    try {
      const r = await idx.call("find_notes_by_tag", {
        vault: "test",
        tag: "shared",
        folder: "proj",
      });
      const d = okData(r) as { matches: Array<{ path: string }> };
      expect(d.matches.map((m) => m.path).sort()).toEqual(["proj", "proj/x.md"]);
    } finally {
      idx.cleanup();
    }
  });

  it("filters out ACL-denied rows", async () => {
    const idx = makeIndexedTagsVault({
      rows: [
        { path: "pub/a.md", tags: ["shared"] },
        { path: "priv/b.md", tags: ["shared"] },
      ],
      acl: { readPaths: ["pub/**"] },
    });
    try {
      const r = await idx.call("find_notes_by_tag", { vault: "test", tag: "shared" });
      const d = okData(r) as { matches: Array<{ path: string }> };
      expect(d.matches.map((m) => m.path)).toEqual(["pub/a.md"]);
    } finally {
      idx.cleanup();
    }
  });

  it("truncates once the limit is reached", async () => {
    const idx = makeIndexedTagsVault({
      rows: [
        { path: "a.md", tags: ["shared"] },
        { path: "b.md", tags: ["shared"] },
      ],
    });
    try {
      const r = await idx.call("find_notes_by_tag", { vault: "test", tag: "shared", limit: 1 });
      const d = okData(r) as { matches: Array<{ path: string }>; truncated: boolean };
      expect(d.truncated).toBe(true);
      expect(d.matches).toHaveLength(1);
    } finally {
      idx.cleanup();
    }
  });
});
