// write_attachment's two latent ACL gaps:
//  1. the pathAcl extractor fell back to the RAW input path when dispatch gave it no vault root, so
//     a bare filename (whose real home is the vault's attachment folder, known only from the root)
//     was ACL-checked at the wrong path. Without the root it now fails closed.
//  2. the handler's own default-deny ran on the LEXICAL path, so with no ACL present an in-vault
//     symlink `pics -> .obsidian` turned a lexically innocent destination into a write under a
//     control directory. It now judges the resolved path.
import * as fs from "node:fs";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/mcp/registry";
import { type M3Deps, registerM3Tools } from "../src/tools/m3";
import { VaultRegistry } from "../src/vault/registry";
import { makeM3Vault } from "./m3-helpers";
import { trySymlink } from "./write-io-backends";

const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");

function pathAclOf() {
  const reg = new ToolRegistry();
  const deps = { vaultRegistry: new VaultRegistry([{ id: "x", path: "/" }]) } as M3Deps;
  registerM3Tools(reg, deps);
  const tool = reg.list().find((t) => t.name === "write_attachment");
  if (!tool?.pathAcl) throw new Error("write_attachment declares no pathAcl");
  return tool.pathAcl as (
    input: { path: string; vault: string },
    env?: { root: string },
  ) => Array<{ op: string; path: string }>;
}

describe("write_attachment pathAcl extractor", () => {
  it("fails closed for a bare filename when no vault root is supplied", () => {
    const pathAcl = pathAclOf();
    // RED before the fix: returned [{ op: "write", path: "pic.png" }], the wrong path.
    expect(() => pathAcl({ path: "pic.png", vault: "x" })).toThrow(/vault root/);
  });

  it("still answers for a path that carries a folder, with or without a root", () => {
    const pathAcl = pathAclOf();
    expect(pathAcl({ path: "a/b.png", vault: "x" })).toEqual([{ op: "write", path: "a/b.png" }]);
    expect(pathAcl({ path: "./b.png", vault: "x" })).toEqual([{ op: "write", path: "b.png" }]);
  });

  it("normalizes (and so rejects traversal in) the fallback path instead of echoing it raw", () => {
    const pathAcl = pathAclOf();
    expect(() => pathAcl({ path: "a/../../x.png", vault: "x" })).toThrow();
  });

  it("with a root, a bare filename resolves into the attachment folder", () => {
    const v = makeM3Vault({ files: { ".obsidian/app.json": '{"attachmentFolderPath":"assets"}' } });
    try {
      const pathAcl = pathAclOf();
      expect(pathAcl({ path: "pic.png", vault: "x" }, { root: v.root })).toEqual([
        { op: "write", path: "assets/pic.png" },
      ]);
    } finally {
      v.cleanup();
    }
  });
});

describe("write_attachment default-deny is judged on the resolved path", () => {
  it("refuses a symlinked folder that resolves under .obsidian, with no ACL present", async () => {
    const v = makeM3Vault();
    try {
      mkdirSync(join(v.root, ".obsidian"));
      if (!trySymlink(fs, join(v.root, ".obsidian"), join(v.root, "pics"))) return;
      const r = await v.call(
        "write_attachment",
        { vault: "test", path: "pics/x.png", content: PNG_B64 },
        { acl: undefined },
      );
      expect(r.ok).toBe(false);
      // RED before the fix: only the writer's own symlink refusal stopped this (and on the JS
      // fallback nothing did); the handler's default-deny never fired on the lexical path.
      if (!r.ok) expect(r.error.message).toMatch(/protected vault directory/);
      expect(readdirSync(join(v.root, ".obsidian"))).toEqual([]);
    } finally {
      v.cleanup();
    }
  });

  it("an ordinary folder still writes with no ACL present", async () => {
    const v = makeM3Vault();
    try {
      const r = await v.call(
        "write_attachment",
        { vault: "test", path: "pics/x.png", content: PNG_B64 },
        { acl: undefined },
      );
      expect(r.ok).toBe(true);
      expect(v.exists("pics/x.png")).toBe(true);
    } finally {
      v.cleanup();
    }
  });
});
