// THE-295 — per-vault ACL: vault A writable, vault B restricted, one process.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { FolderAcl, makeIndexReadable } from "../src/acl";
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
  const rootA = mkdtempSync(join(tmpdir(), "obtc-295a-"));
  const rootB = mkdtempSync(join(tmpdir(), "obtc-295b-"));
  const write = (root: string, rel: string, content: string): void => {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  const rootAcl = new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] });
  const aclByVault = new Map<string, FolderAcl>([
    ["b", new FolderAcl({ readOnly: true, defaultScopes: [], rules: [] })],
    [
      "c",
      new FolderAcl({
        readOnly: false,
        defaultScopes: [],
        rules: [],
        writePaths: ["allowed/**"],
      }),
    ],
  ]);
  const registry = new ToolRegistry({
    aclResolver: (vid) => aclByVault.get(vid) ?? rootAcl,
  });
  registerM1Tools(registry, {
    vaultRegistry: new VaultRegistry([
      { id: "a", path: rootA },
      { id: "b", path: rootB },
      { id: "c", path: rootB },
    ]),
    version: "0.0.0",
    startedAt: 0,
    embeddings: { provider: "p", model: "m" },
  });
  const ctx = (): CallerContext => ({
    caller: "t",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: "a",
    db: stubDb,
    acl: rootAcl,
  });
  const call = (name: string, input: Record<string, unknown>) =>
    registry.dispatch(name, input, ctx());
  return {
    write,
    rootA,
    rootB,
    call,
    cleanup: () => {
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
    },
  };
}

describe("per-vault ACL (THE-295)", () => {
  it("vault A writes while vault B is read-only, in one process", async () => {
    const h = harness();
    try {
      const a = await h.call("write_note", {
        vault: "a",
        path: "n.md",
        content: "ok",
        mode: "upsert",
      });
      expect(a.ok).toBe(true);
      const b = await h.call("write_note", {
        vault: "b",
        path: "n.md",
        content: "nope",
        mode: "upsert",
      });
      expect(b.ok).toBe(false);
      if (!b.ok) {
        expect(b.error.code).toBe("forbidden");
        expect(b.error.message).toContain("read-only");
      }
      // Reads on B still work under its ACL.
      h.write(h.rootB, "r.md", "readable");
      const r = await h.call("read_note", { vault: "b", path: "r.md" });
      expect(r.ok).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it("a per-vault write whitelist gates paths for that vault only", async () => {
    const h = harness();
    try {
      const denied = await h.call("write_note", {
        vault: "c",
        path: "outside.md",
        content: "x",
        mode: "upsert",
      });
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error.code).toBe("acl_denied");
      const allowed = await h.call("write_note", {
        vault: "c",
        path: "allowed/in.md",
        content: "x",
        mode: "upsert",
      });
      expect(allowed.ok).toBe(true);
      // The same path on vault A (root ACL, allow-all) is unaffected.
      const rootSide = await h.call("write_note", {
        vault: "a",
        path: "outside.md",
        content: "x",
        mode: "upsert",
      });
      expect(rootSide.ok).toBe(true);
    } finally {
      h.cleanup();
    }
  });
});

describe("makeIndexReadable — per-vault ACL at INDEXING time (THE-453)", () => {
  it("honors a restrictive vault override that a permissive root would allow (no leak to embeddings)", () => {
    // Root allows everything; vault "secret" restricts reads to public/**.
    const rootAcl = new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] });
    const aclByVault = new Map<string, FolderAcl>([
      [
        "secret",
        new FolderAcl({
          readOnly: false,
          defaultScopes: [],
          rules: [],
          readPaths: ["public/**"],
        }),
      ],
    ]);
    const readableFor = makeIndexReadable(rootAcl, aclByVault);

    // The bug: indexing closed over the ROOT acl, so a vault-denied note was still indexed/embedded.
    const secret = readableFor("secret");
    expect(secret("private/diary.md")).toBe(false); // vault override denies -> never embedded
    expect(secret("public/notes.md")).toBe(true); // vault override allows

    // A vault with no override falls back to the permissive root, unchanged.
    const other = readableFor("other");
    expect(other("private/diary.md")).toBe(true);
  });

  it("honors a permissive vault override that a restrictive root would block", () => {
    // Root is strict-deny by default; vault "open" opens everything.
    const rootAcl = new FolderAcl({
      readOnly: false,
      defaultScopes: [],
      rules: [],
      strictReadDefault: true,
    });
    const aclByVault = new Map<string, FolderAcl>([
      ["open", new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] })],
    ]);
    const readableFor = makeIndexReadable(rootAcl, aclByVault);

    expect(readableFor("open")("anything.md")).toBe(true); // vault override permits
    expect(readableFor("locked")("anything.md")).toBe(false); // falls back to strict root
  });

  it("default-denied paths stay denied regardless of ACL", () => {
    const rootAcl = new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] });
    const readableFor = makeIndexReadable(rootAcl, new Map());
    // .obsidian/** and similar are hard-denied by isDefaultDenied even under an allow-all root.
    expect(readableFor("v")(".obsidian/workspace.json")).toBe(false);
  });
});
