// THE-602: branch-coverage top-up for src/tools/m1/frontmatter-tools.ts. Every test here asserts
// caller-visible behavior (a thrown error's code, a returned value, or a persisted file's
// content) — never a branch executed for its own sake. See test/frontmatter-tools.test.ts for the
// primary behavioral suite this one supplements; test/m1-helpers.ts's makeTestVault runs the
// walkVault (disk-scan) path only, so the deps.metadataIndex-ready() branches of list_properties /
// find_notes_by_property (querying the `notes` table instead of walking the filesystem) need a
// second, local harness that seeds that table directly.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { type AclConfigT, FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { buildFrontmatterTools } from "../src/tools/m1/frontmatter-tools";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";
import { makeTestVault } from "./m1-helpers";
import { rmTemp } from "./tmp";

function errCode(r: ToolResult): string {
  if (r.ok) throw new Error("expected an error result");
  return r.error.code;
}

// Local harness for the deps.metadataIndex.ready() branches: list_properties and
// find_notes_by_property read straight from the `notes` table instead of walking the vault when
// the index is "ready". makeTestVault (test/m1-helpers.ts) never wires metadataIndex, so those
// branches are unreachable through it — this seeds the table directly, mirroring the pattern in
// test/graph-metadata-prior.test.ts's addNote / test/acl-extraction-coverage.test.ts's
// metadataIndex stub.
interface IndexedRow {
  path: string;
  frontmatter: Record<string, unknown> | null;
}

function makeIndexedVault(opts: { rows: IndexedRow[]; acl?: Partial<AclConfigT> }): {
  db: Database;
  call: (name: string, input: Record<string, unknown>) => Promise<ToolResult>;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "obtc-idx-vault-"));
  const db = openMemoryDb();
  provisionCacheDb(db);
  const insert = db.prepare(
    `INSERT INTO notes (vault_id, path, title, tags, frontmatter, content_hash, mtime, size, indexed_at)
     VALUES ('test', ?, ?, '[]', ?, ?, 0, 0, 0)`,
  );
  for (const row of opts.rows) {
    insert.run(
      row.path,
      row.path,
      row.frontmatter ? JSON.stringify(row.frontmatter) : null,
      `h-${row.path}`,
    );
  }
  const aclCfg: AclConfigT = { readOnly: false, defaultScopes: [], rules: [], ...opts.acl };
  const acl = new FolderAcl(aclCfg);
  const vaultRegistry = new VaultRegistry([{ id: "test", path: root }]);
  const registry = new ToolRegistry();
  for (const tool of buildFrontmatterTools({
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
    db,
    call: (name, input) => registry.dispatch(name, input, ctx),
    cleanup: () => rmTemp(root),
  };
}

describe("typeOf: null frontmatter values are reported as type 'null'", () => {
  it("list_properties types include 'null' for an explicit YAML null", async () => {
    const v = makeTestVault({ files: { "a.md": "---\nstatus: null\ncount: 1\n---\nbody\n" } });
    try {
      const r = await v.call("list_properties", { vault: "test" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { properties: Array<{ key: string; types: string[] }> };
        expect(d.properties.find((p) => p.key === "status")?.types).toEqual(["null"]);
      }
    } finally {
      v.cleanup();
    }
  });
});

describe("valueMatches: array-vs-array equality fallback", () => {
  it("matches when the query equals the whole stored array (no single element equals it)", async () => {
    const v = makeTestVault({
      files: {
        "a.md": "---\ntags: [x, y]\n---\n",
        "b.md": "---\ntags: [x]\n---\n",
      },
    });
    try {
      // Neither "x" nor "y" alone equals ["x","y"], so the per-element `.some` leg is false for
      // a.md and the whole-array `eq(stored, query)` fallback is what matches it.
      const r = await v.call("find_notes_by_property", {
        vault: "test",
        key: "tags",
        value: ["x", "y"],
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { matches: Array<{ path: string }> };
        expect(d.matches.map((m) => m.path)).toEqual(["a.md"]);
      }
    } finally {
      v.cleanup();
    }
  });
});

describe("setByPath / removeByPath: non-object intermediate segments", () => {
  it("nested set through an existing nested OBJECT extends it in place", async () => {
    const v = makeTestVault({
      files: { "a.md": "---\nmeta:\n  author:\n    name: Ada\n---\nbody\n" },
    });
    try {
      const set = await v.call("update_frontmatter", {
        vault: "test",
        path: "a.md",
        operation: "set",
        key: "meta.author.age",
        value: 30,
        nested: true,
      });
      expect(set.ok).toBe(true);
      if (set.ok) {
        const fm = (set.data as { frontmatter: Record<string, unknown> }).frontmatter;
        // The pre-existing meta.author.name survives — proof the existing object was reused
        // (childObj = child), not replaced by a fresh {}.
        expect(fm).toEqual({ meta: { author: { name: "Ada", age: 30 } } });
      }
    } finally {
      v.cleanup();
    }
  });

  it("nested set through an ARRAY intermediate replaces it with a fresh object", async () => {
    const v = makeTestVault({ files: { "a.md": "---\nmeta: [1, 2, 3]\n---\nbody\n" } });
    try {
      const set = await v.call("update_frontmatter", {
        vault: "test",
        path: "a.md",
        operation: "set",
        key: "meta.author",
        value: "Ada",
        nested: true,
      });
      expect(set.ok).toBe(true);
      if (set.ok) {
        const fm = (set.data as { frontmatter: Record<string, unknown> }).frontmatter;
        // The array is discarded, not merged into — the child-is-array leg short-circuits the
        // "reuse the existing object" path.
        expect(fm).toEqual({ meta: { author: "Ada" } });
      }
    } finally {
      v.cleanup();
    }
  });

  it("nested remove through a non-object (string) intermediate is a no-op, not a crash", async () => {
    const v = makeTestVault({ files: { "a.md": "---\nmeta: plainstring\nk: 1\n---\nbody\n" } });
    try {
      const rm = await v.call("update_frontmatter", {
        vault: "test",
        path: "a.md",
        operation: "remove",
        key: "meta.author.name",
        nested: true,
      });
      expect(rm.ok).toBe(true);
      if (rm.ok) {
        const fm = (rm.data as { frontmatter: Record<string, unknown> }).frontmatter;
        // removeByPath bails out and returns obj unchanged when the path doesn't resolve
        // through objects — "meta" stays the plain string it always was.
        expect(fm).toEqual({ meta: "plainstring", k: 1 });
      }
    } finally {
      v.cleanup();
    }
  });

  it("nested remove through an ARRAY intermediate is also a no-op", async () => {
    const v = makeTestVault({ files: { "a.md": "---\nmeta: [1, 2]\n---\nbody\n" } });
    try {
      const rm = await v.call("update_frontmatter", {
        vault: "test",
        path: "a.md",
        operation: "remove",
        key: "meta.x.y",
        nested: true,
      });
      expect(rm.ok).toBe(true);
      if (rm.ok) {
        const fm = (rm.data as { frontmatter: Record<string, unknown> }).frontmatter;
        expect(fm).toEqual({ meta: [1, 2] });
      }
    } finally {
      v.cleanup();
    }
  });
});

describe("read_frontmatter / read_property: not-found and folder guards", () => {
  it("read_frontmatter on a missing path throws note_not_found", async () => {
    const v = makeTestVault({ files: { "a.md": "---\nx: 1\n---\n" } });
    try {
      const r = await v.call("read_frontmatter", { vault: "test", path: "ghost.md" });
      expect(r.ok).toBe(false);
      expect(errCode(r)).toBe("note_not_found");
    } finally {
      v.cleanup();
    }
  });

  it("read_frontmatter on a folder path throws note_not_found", async () => {
    const v = makeTestVault({ files: { "sub/.keep": "x" } });
    try {
      const r = await v.call("read_frontmatter", { vault: "test", path: "sub" });
      expect(r.ok).toBe(false);
      expect(errCode(r)).toBe("note_not_found");
    } finally {
      v.cleanup();
    }
  });

  it("read_property on a missing path throws note_not_found", async () => {
    const v = makeTestVault({ files: { "a.md": "---\nx: 1\n---\n" } });
    try {
      const r = await v.call("read_property", { vault: "test", path: "ghost.md", key: "x" });
      expect(r.ok).toBe(false);
      expect(errCode(r)).toBe("note_not_found");
    } finally {
      v.cleanup();
    }
  });

  it("read_property on a folder path throws note_not_found", async () => {
    const v = makeTestVault({ files: { "sub/.keep": "x" } });
    try {
      const r = await v.call("read_property", { vault: "test", path: "sub", key: "x" });
      expect(r.ok).toBe(false);
      expect(errCode(r)).toBe("note_not_found");
    } finally {
      v.cleanup();
    }
  });

  it("read_property on a note with NO frontmatter block falls back to {} (found: false)", async () => {
    const v = makeTestVault({ files: { "plain.md": "just a body, no frontmatter" } });
    try {
      const r = await v.call("read_property", { vault: "test", path: "plain.md", key: "title" });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.data).toMatchObject({ value: null, found: false });
    } finally {
      v.cleanup();
    }
  });
});

describe("update_frontmatter: folder guard, create_if_missing, and required-field validation", () => {
  it("update_frontmatter on a folder path throws invalid_input", async () => {
    const v = makeTestVault({ files: { "sub/.keep": "x" } });
    try {
      const r = await v.call("update_frontmatter", {
        vault: "test",
        path: "sub",
        operation: "set",
        key: "x",
        value: 1,
      });
      expect(r.ok).toBe(false);
      expect(errCode(r)).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });

  it("create_if_missing=true creates a new note when the target doesn't exist", async () => {
    const v = makeTestVault({ files: {} });
    try {
      const r = await v.call("update_frontmatter", {
        vault: "test",
        path: "new.md",
        operation: "set",
        key: "status",
        value: "draft",
        create_if_missing: true,
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.data).toMatchObject({ created: true, prev_hash: null });
        expect((r.data as { frontmatter: Record<string, unknown> }).frontmatter).toEqual({
          status: "draft",
        });
      }
      expect(v.exists("new.md")).toBe(true);
      expect(v.read("new.md")).toBe("---\nstatus: draft\n---\n");
    } finally {
      v.cleanup();
    }
  });

  it("set without key is invalid_input", async () => {
    const v = makeTestVault({ files: { "a.md": "---\nx: 1\n---\n" } });
    try {
      const r = await v.call("update_frontmatter", {
        vault: "test",
        path: "a.md",
        operation: "set",
        value: 1,
      });
      expect(r.ok).toBe(false);
      expect(errCode(r)).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });

  it("set without a value field at all is invalid_input (distinct from explicit null)", async () => {
    const v = makeTestVault({ files: { "a.md": "---\nx: 1\n---\n" } });
    try {
      const noValue = await v.call("update_frontmatter", {
        vault: "test",
        path: "a.md",
        operation: "set",
        key: "y",
      });
      expect(noValue.ok).toBe(false);
      expect(errCode(noValue)).toBe("invalid_input");

      // Contrast: an EXPLICIT null value is accepted and stored, proving the guard is really
      // about field presence, not value truthiness.
      const explicitNull = await v.call("update_frontmatter", {
        vault: "test",
        path: "a.md",
        operation: "set",
        key: "y",
        value: null,
      });
      expect(explicitNull.ok).toBe(true);
      if (explicitNull.ok)
        expect((explicitNull.data as { frontmatter: Record<string, unknown> }).frontmatter).toEqual(
          { x: 1, y: null },
        );
    } finally {
      v.cleanup();
    }
  });

  it("remove without key is invalid_input", async () => {
    const v = makeTestVault({ files: { "a.md": "---\nx: 1\n---\n" } });
    try {
      const r = await v.call("update_frontmatter", {
        vault: "test",
        path: "a.md",
        operation: "remove",
      });
      expect(r.ok).toBe(false);
      expect(errCode(r)).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });

  it("merge without properties is invalid_input", async () => {
    const v = makeTestVault({ files: { "a.md": "---\nx: 1\n---\n" } });
    try {
      const r = await v.call("update_frontmatter", {
        vault: "test",
        path: "a.md",
        operation: "merge",
      });
      expect(r.ok).toBe(false);
      expect(errCode(r)).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });

  it("replace without properties is invalid_input, thrown before the confirmation gate", async () => {
    const v = makeTestVault({ files: { "a.md": "---\nx: 1\n---\n" } });
    try {
      // No elicitToken supplied — if this reached requireConfirmation first it would fail with
      // elicit_required instead, so invalid_input proves the properties check runs first.
      const r = await v.call("update_frontmatter", {
        vault: "test",
        path: "a.md",
        operation: "replace",
      });
      expect(r.ok).toBe(false);
      expect(errCode(r)).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });

  it("removing the only remaining key drops the frontmatter block entirely (hasKeys=false)", async () => {
    const v = makeTestVault({ files: { "a.md": "---\nonly: 1\n---\nbody\n" } });
    try {
      const r = await v.call("update_frontmatter", {
        vault: "test",
        path: "a.md",
        operation: "remove",
        key: "only",
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.data as { frontmatter: unknown }).frontmatter).toBeNull();
      // serializeNote(null, ...) must not emit an empty "---\n---\n" block.
      expect(v.read("a.md")).toBe("body\n");
    } finally {
      v.cleanup();
    }
  });
});

describe("list_properties: folder scoping, max_notes break, and sort tie-break", () => {
  it("folder param scopes the disk scan to the given subtree", async () => {
    const v = makeTestVault({
      files: {
        "pub/a.md": "---\ntitle: A\n---\n",
        "other/b.md": "---\ntitle: B\n---\n",
      },
    });
    try {
      const r = await v.call("list_properties", { vault: "test", folder: "pub" });
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.data as { notes_scanned: number }).notes_scanned).toBe(1);
    } finally {
      v.cleanup();
    }
  });

  it("max_notes stops the disk scan early (deterministic count, not just non-crashing)", async () => {
    const v = makeTestVault({
      files: {
        "a.md": "---\nk: 1\n---\n",
        "b.md": "---\nk: 1\n---\n",
        "c.md": "---\nk: 1\n---\n",
      },
    });
    try {
      const r = await v.call("list_properties", { vault: "test", max_notes: 2 });
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.data as { notes_scanned: number }).notes_scanned).toBe(2);
    } finally {
      v.cleanup();
    }
  });

  it("a note with no frontmatter block is scanned but contributes nothing to the tally", async () => {
    const v = makeTestVault({
      files: {
        "a.md": "---\ntitle: A\n---\n",
        "plain.md": "no frontmatter at all",
      },
    });
    try {
      const r = await v.call("list_properties", { vault: "test" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { notes_scanned: number; properties: Array<{ key: string }> };
        // Both notes are scanned (the counter doesn't know a note is frontmatter-less until it's
        // parsed)...
        expect(d.notes_scanned).toBe(2);
        // ...but only the one WITH frontmatter shows up in the aggregated properties.
        expect(d.properties.map((p) => p.key)).toEqual(["title"]);
      }
    } finally {
      v.cleanup();
    }
  });

  it("equal-count properties tie-break alphabetically by key", async () => {
    const v = makeTestVault({
      files: {
        // "zeta" and "alpha" each appear on exactly one note => equal counts, so the sort must
        // fall through to localeCompare and put alpha first despite zeta being written first.
        "a.md": "---\nzeta: 1\nalpha: 1\n---\n",
      },
    });
    try {
      const r = await v.call("list_properties", { vault: "test" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const keys = (r.data as { properties: Array<{ key: string }> }).properties.map(
          (p) => p.key,
        );
        const ia = keys.indexOf("alpha");
        const idxZ = keys.indexOf("zeta");
        expect(ia).toBeGreaterThanOrEqual(0);
        expect(ia).toBeLessThan(idxZ);
      }
    } finally {
      v.cleanup();
    }
  });
});

describe("find_notes_by_property: folder scoping and limit truncation", () => {
  it("folder param scopes the disk scan to the given subtree", async () => {
    const v = makeTestVault({
      files: {
        "pub/a.md": "---\nstatus: done\n---\n",
        "other/b.md": "---\nstatus: done\n---\n",
      },
    });
    try {
      const r = await v.call("find_notes_by_property", {
        vault: "test",
        key: "status",
        folder: "pub",
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { matches: Array<{ path: string }> };
        expect(d.matches.map((m) => m.path)).toEqual(["pub/a.md"]);
      }
    } finally {
      v.cleanup();
    }
  });

  it("a note with no frontmatter block is skipped (considered a non-match, not an error)", async () => {
    const v = makeTestVault({
      files: {
        "a.md": "---\nstatus: done\n---\n",
        "plain.md": "no frontmatter at all",
      },
    });
    try {
      const r = await v.call("find_notes_by_property", { vault: "test", key: "status" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { matches: Array<{ path: string }> };
        expect(d.matches.map((m) => m.path)).toEqual(["a.md"]);
      }
    } finally {
      v.cleanup();
    }
  });

  it("limit truncates results and reports truncated: true", async () => {
    const v = makeTestVault({
      files: {
        "a.md": "---\nstatus: done\n---\n",
        "b.md": "---\nstatus: done\n---\n",
        "c.md": "---\nstatus: done\n---\n",
      },
    });
    try {
      const r = await v.call("find_notes_by_property", { vault: "test", key: "status", limit: 2 });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { total: number; truncated: boolean; matches: Array<{ path: string }> };
        expect(d.matches.length).toBe(2);
        expect(d.total).toBe(2);
        expect(d.truncated).toBe(true);
      }
    } finally {
      v.cleanup();
    }
  });
});

describe("list_properties / find_notes_by_property: metadataIndex.ready() (notes-table) path", () => {
  it("list_properties: folder filter, ACL filter, and max_notes break all apply over DB rows", async () => {
    const v = makeIndexedVault({
      rows: [
        { path: "pub/a.md", frontmatter: { title: "A" } },
        { path: "pub/b.md", frontmatter: { title: "B" } },
        { path: "other/c.md", frontmatter: { title: "C" } }, // outside folder filter
        { path: "priv/d.md", frontmatter: { secret: 1 } }, // outside ACL
      ],
      acl: { readPaths: ["pub/**"] },
    });
    try {
      const r = await v.call("list_properties", { vault: "test", folder: "pub", max_notes: 1 });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as {
          notes_scanned: number;
          properties: Array<{ key: string }>;
        };
        // other/c.md excluded by the folder filter, priv/d.md would be excluded by ACL too, and
        // max_notes=1 stops after the first qualifying row (pub/a.md).
        expect(d.notes_scanned).toBe(1);
        expect(d.properties.map((p) => p.key)).toEqual(["title"]);
      }
    } finally {
      v.cleanup();
    }
  });

  it("list_properties over DB rows: ACL alone filters a row out (no folder, no truncation)", async () => {
    const v = makeIndexedVault({
      rows: [
        { path: "pub/a.md", frontmatter: { title: "A" } },
        { path: "priv/b.md", frontmatter: { secret: 1 } },
      ],
      acl: { readPaths: ["pub/**"] },
    });
    try {
      const r = await v.call("list_properties", { vault: "test" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { notes_scanned: number; properties: Array<{ key: string }> };
        expect(d.notes_scanned).toBe(1);
        expect(d.properties.some((p) => p.key === "secret")).toBe(false);
      }
    } finally {
      v.cleanup();
    }
  });

  it("list_properties over DB rows: a NULL frontmatter column is skipped, not a crash", async () => {
    const v = makeIndexedVault({
      rows: [
        { path: "a.md", frontmatter: { title: "A" } },
        { path: "b.md", frontmatter: null },
      ],
    });
    try {
      const r = await v.call("list_properties", { vault: "test" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { notes_scanned: number; properties: Array<{ key: string }> };
        expect(d.notes_scanned).toBe(2);
        expect(d.properties.map((p) => p.key)).toEqual(["title"]);
      }
    } finally {
      v.cleanup();
    }
  });

  it("find_notes_by_property: folder filter applies over DB rows", async () => {
    const v = makeIndexedVault({
      rows: [
        { path: "pub/a.md", frontmatter: { status: "done" } },
        { path: "other/b.md", frontmatter: { status: "done" } },
      ],
    });
    try {
      const r = await v.call("find_notes_by_property", {
        vault: "test",
        key: "status",
        folder: "pub",
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { matches: Array<{ path: string }> };
        expect(d.matches.map((m) => m.path)).toEqual(["pub/a.md"]);
      }
    } finally {
      v.cleanup();
    }
  });

  it("find_notes_by_property: ACL filters a row out over DB rows", async () => {
    const v = makeIndexedVault({
      rows: [
        { path: "pub/a.md", frontmatter: { status: "done" } },
        { path: "priv/b.md", frontmatter: { status: "done" } },
      ],
      acl: { readPaths: ["pub/**"] },
    });
    try {
      const r = await v.call("find_notes_by_property", { vault: "test", key: "status" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { matches: Array<{ path: string }> };
        expect(d.matches.map((m) => m.path)).toEqual(["pub/a.md"]);
      }
    } finally {
      v.cleanup();
    }
  });

  it("find_notes_by_property over DB rows: a NULL frontmatter column is skipped, not a crash", async () => {
    const v = makeIndexedVault({
      rows: [
        { path: "a.md", frontmatter: { status: "done" } },
        { path: "b.md", frontmatter: null },
      ],
    });
    try {
      const r = await v.call("find_notes_by_property", { vault: "test", key: "status" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { matches: Array<{ path: string }> };
        expect(d.matches.map((m) => m.path)).toEqual(["a.md"]);
      }
    } finally {
      v.cleanup();
    }
  });

  it("find_notes_by_property: limit truncates and breaks the DB-row scan", async () => {
    const v = makeIndexedVault({
      rows: [
        { path: "a.md", frontmatter: { status: "done" } },
        { path: "b.md", frontmatter: { status: "done" } },
        { path: "c.md", frontmatter: { status: "done" } },
      ],
    });
    try {
      const r = await v.call("find_notes_by_property", { vault: "test", key: "status", limit: 1 });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { total: number; truncated: boolean; matches: Array<{ path: string }> };
        expect(d.matches.length).toBe(1);
        expect(d.truncated).toBe(true);
      }
    } finally {
      v.cleanup();
    }
  });
});
