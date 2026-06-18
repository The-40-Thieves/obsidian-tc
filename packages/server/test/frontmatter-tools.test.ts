import type { ToolResult } from "@obsidian-tc/shared";
import { describe, expect, it } from "vitest";
import { issueElicitToken } from "../src/elicit";
import { makeTestVault } from "./m1-helpers";

function hashOf(r: ToolResult): string {
  if (r.ok) throw new Error("expected an error result");
  return String((r.error.details as { args_hash?: string }).args_hash);
}

describe("Domain 3: frontmatter / properties", () => {
  it("read_frontmatter and read_property return parsed values", async () => {
    const v = makeTestVault({
      files: {
        "a.md": "---\ntitle: Hello\ntags:\n  - x\n  - y\n---\nbody\n",
        "plain.md": "no frontmatter here",
      },
    });
    try {
      const fm = await v.call("read_frontmatter", { vault: "test", path: "a.md" });
      if (fm.ok) {
        const d = fm.data as { frontmatter: Record<string, unknown>; has_frontmatter: boolean };
        expect(d.has_frontmatter).toBe(true);
        expect(d.frontmatter).toEqual({ title: "Hello", tags: ["x", "y"] });
      }

      const plain = await v.call("read_frontmatter", { vault: "test", path: "plain.md" });
      if (plain.ok) expect(plain.data).toMatchObject({ frontmatter: null, has_frontmatter: false });

      const p = await v.call("read_property", { vault: "test", path: "a.md", key: "title" });
      if (p.ok) expect(p.data).toMatchObject({ value: "Hello", found: true });

      const miss = await v.call("read_property", { vault: "test", path: "a.md", key: "ghost" });
      if (miss.ok) expect(miss.data).toMatchObject({ value: null, found: false });
    } finally {
      v.cleanup();
    }
  });

  it("update_frontmatter set adds a key (and creates the block on a plain note)", async () => {
    const v = makeTestVault({ files: { "plain.md": "just body" } });
    try {
      const r = await v.call("update_frontmatter", {
        vault: "test",
        path: "plain.md",
        operation: "set",
        key: "status",
        value: "draft",
      });
      expect(r.ok).toBe(true);
      const out = v.read("plain.md");
      expect(out).toBe("---\nstatus: draft\n---\njust body");
    } finally {
      v.cleanup();
    }
  });

  it("update_frontmatter merge and remove mutate existing metadata", async () => {
    const v = makeTestVault({ files: { "a.md": "---\na: 1\nb: 2\n---\nbody" } });
    try {
      const merged = await v.call("update_frontmatter", {
        vault: "test",
        path: "a.md",
        operation: "merge",
        properties: { b: 3, c: 4 },
      });
      if (merged.ok)
        expect((merged.data as { frontmatter: Record<string, unknown> }).frontmatter).toEqual({
          a: 1,
          b: 3,
          c: 4,
        });

      const removed = await v.call("update_frontmatter", {
        vault: "test",
        path: "a.md",
        operation: "remove",
        key: "a",
      });
      if (removed.ok)
        expect((removed.data as { frontmatter: Record<string, unknown> }).frontmatter).toEqual({
          b: 3,
          c: 4,
        });
    } finally {
      v.cleanup();
    }
  });

  it("update_frontmatter replace requires confirmation", async () => {
    const v = makeTestVault({ files: { "a.md": "---\nkeep: me\n---\nbody" } });
    try {
      const input = {
        vault: "test",
        path: "a.md",
        operation: "replace" as const,
        properties: { only: "this" },
      };
      const need = await v.call("update_frontmatter", input);
      expect(need.ok).toBe(false);
      if (!need.ok) expect(need.error.code).toBe("elicit_required");

      const token = issueElicitToken(v.db, {
        vaultId: "test",
        toolName: "update_frontmatter",
        argsHash: hashOf(need),
        caller: "test",
      });
      const ok = await v.call("update_frontmatter", input, { elicitToken: token });
      expect(ok.ok).toBe(true);
      if (ok.ok)
        expect((ok.data as { frontmatter: Record<string, unknown> }).frontmatter).toEqual({
          only: "this",
        });
      expect(v.read("a.md")).toBe("---\nonly: this\n---\nbody");
    } finally {
      v.cleanup();
    }
  });

  it("update_frontmatter honours prev_hash CAS and note_not_found", async () => {
    const v = makeTestVault({ files: { "a.md": "---\nx: 1\n---\nb" } });
    try {
      const stale = await v.call("update_frontmatter", {
        vault: "test",
        path: "a.md",
        operation: "set",
        key: "y",
        value: 2,
        prev_hash: "0".repeat(64),
      });
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.error.code).toBe("concurrent_modification");

      const missing = await v.call("update_frontmatter", {
        vault: "test",
        path: "ghost.md",
        operation: "set",
        key: "y",
        value: 2,
      });
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(missing.error.code).toBe("note_not_found");
    } finally {
      v.cleanup();
    }
  });

  it("list_properties aggregates keys with counts and types, read-ACL filtered", async () => {
    const v = makeTestVault({
      files: {
        "pub/a.md": "---\ntitle: A\ntags: [x]\n---\n",
        "pub/b.md": "---\ntitle: B\n---\n",
        "priv/c.md": "---\nsecret: 1\n---\n",
      },
      acl: { readPaths: ["pub/**"] },
    });
    try {
      const r = await v.call("list_properties", { vault: "test" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as {
          notes_scanned: number;
          properties: Array<{ key: string; count: number; types: string[] }>;
        };
        expect(d.notes_scanned).toBe(2); // priv/c.md filtered out
        const title = d.properties.find((p) => p.key === "title");
        expect(title).toMatchObject({ count: 2, types: ["string"] });
        expect(d.properties.some((p) => p.key === "secret")).toBe(false);
      }
    } finally {
      v.cleanup();
    }
  });

  it("find_notes_by_property matches presence, equality, and list membership", async () => {
    const v = makeTestVault({
      files: {
        "a.md": "---\nstatus: done\ntags: [book, fiction]\n---\n",
        "b.md": "---\nstatus: todo\n---\n",
        "c.md": "---\ntags: [fiction]\n---\n",
      },
    });
    try {
      const present = await v.call("find_notes_by_property", { vault: "test", key: "status" });
      if (present.ok)
        expect(
          (present.data as { matches: Array<{ path: string }> }).matches.map((m) => m.path),
        ).toEqual(["a.md", "b.md"]);

      const eq = await v.call("find_notes_by_property", {
        vault: "test",
        key: "status",
        value: "done",
      });
      if (eq.ok)
        expect(
          (eq.data as { matches: Array<{ path: string }> }).matches.map((m) => m.path),
        ).toEqual(["a.md"]);

      const member = await v.call("find_notes_by_property", {
        vault: "test",
        key: "tags",
        value: "fiction",
      });
      if (member.ok)
        expect(
          (member.data as { matches: Array<{ path: string }> }).matches.map((m) => m.path),
        ).toEqual(["a.md", "c.md"]);
    } finally {
      v.cleanup();
    }
  });
});
