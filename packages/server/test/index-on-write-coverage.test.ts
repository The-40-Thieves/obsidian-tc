// THE-291 part 1 — every M1 note mutation must fire the index-on-write seam.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import type { Database } from "../src/db/types";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { registerM1Tools } from "../src/tools/m1";
import { VaultRegistry } from "../src/vault/registry";

const stubDb = {
  prepare() {
    throw new Error("no db in this unit test");
  },
} as unknown as Database;

function harness() {
  const root = mkdtempSync(join(tmpdir(), "obtc-291a-"));
  const write = (rel: string, content: string): void => {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  const reindexed: Array<{ path: string; content: string }> = [];
  const deindexed: string[] = [];
  const registry = new ToolRegistry();
  registerM1Tools(registry, {
    vaultRegistry: new VaultRegistry([{ id: "t", path: root }]),
    version: "0.0.0",
    startedAt: 0,
    embeddings: { provider: "p", model: "m" },
    reindex: (_v, path, content) => reindexed.push({ path, content }),
    deindex: (_v, path) => deindexed.push(path),
  });
  const ctx = (): CallerContext => ({
    caller: "t",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: "t",
    db: stubDb,
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
  });
  const call = (name: string, input: Record<string, unknown>) =>
    registry.dispatch(name, input, ctx());
  return {
    root,
    write,
    call,
    reindexed,
    deindexed,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("index-on-write coverage (THE-291 part 1)", () => {
  it("add_tag and remove_tag reindex the written content", async () => {
    const h = harness();
    try {
      h.write("a.md", "hello body\n");
      const add = await h.call("add_tag", { vault: "t", path: "a.md", tag: "focus" });
      expect(add.ok).toBe(true);
      expect(h.reindexed.at(-1)?.path).toBe("a.md");
      expect(h.reindexed.at(-1)?.content).toContain("focus");
      const rm = await h.call("remove_tag", { vault: "t", path: "a.md", tag: "focus" });
      expect(rm.ok).toBe(true);
      expect(h.reindexed).toHaveLength(2);
      expect(h.reindexed.at(-1)?.content).not.toContain("focus");
    } finally {
      h.cleanup();
    }
  });

  it("update_frontmatter reindexes", async () => {
    const h = harness();
    try {
      h.write("b.md", "body\n");
      const r = await h.call("update_frontmatter", {
        vault: "t",
        path: "b.md",
        operation: "set",
        key: "status",
        value: "active",
      });
      expect(r.ok).toBe(true);
      expect(h.reindexed.at(-1)?.path).toBe("b.md");
      expect(h.reindexed.at(-1)?.content).toContain("status");
    } finally {
      h.cleanup();
    }
  });

  it("move_note deindexes the source, reindexes the destination AND backlink-rewritten notes", async () => {
    const h = harness();
    try {
      h.write("a.md", "the moving note\n");
      h.write("linker.md", "see [[a]]\n");
      const r = await h.call("move_note", { vault: "t", from: "a.md", to: "b.md" });
      expect(r.ok).toBe(true);
      expect(h.deindexed).toContain("a.md");
      const paths = h.reindexed.map((x) => x.path);
      expect(paths).toContain("b.md");
      expect(paths).toContain("linker.md");
      const linker = h.reindexed.find((x) => x.path === "linker.md");
      expect(linker?.content).toContain("[[b]]");
    } finally {
      h.cleanup();
    }
  });

  it("copy_note reindexes the destination", async () => {
    const h = harness();
    try {
      h.write("a.md", "copy me\n");
      const r = await h.call("copy_note", { vault: "t", from: "a.md", to: "c.md" });
      expect(r.ok).toBe(true);
      expect(h.reindexed.at(-1)).toEqual({ path: "c.md", content: "copy me\n" });
    } finally {
      h.cleanup();
    }
  });
});
