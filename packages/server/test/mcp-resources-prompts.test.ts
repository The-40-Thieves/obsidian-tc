import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import type { FolderAcl } from "../src/acl";
import type { Database } from "../src/db/types";
import { getPrompt, listPrompts } from "../src/mcp/prompts";
import type { CallerContext } from "../src/mcp/registry";
import {
  buildResourceUri,
  listResources,
  parseResourceUri,
  readResource,
} from "../src/mcp/resources";
import { VaultRegistry } from "../src/vault/registry";

function tempVault(): VaultRegistry {
  const dir = mkdtempSync(join(tmpdir(), "otc-res-"));
  writeFileSync(join(dir, "alpha.md"), "# Alpha\nhello");
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "beta.md"), "# Beta\nworld");
  mkdirSync(join(dir, ".obsidian"));
  writeFileSync(join(dir, ".obsidian", "skip.md"), "ignored");
  const cfg = ServerConfigSchema.parse({ vaults: [{ id: "main", path: dir }] });
  return new VaultRegistry(cfg.vaults);
}

/** A two-vault registry ("main" + "other"), each holding a distinct note, for cross-vault tests. */
function tempMultiVault(): VaultRegistry {
  const mainDir = mkdtempSync(join(tmpdir(), "otc-res-main-"));
  writeFileSync(join(mainDir, "alpha.md"), "# Alpha\nhello");
  const otherDir = mkdtempSync(join(tmpdir(), "otc-res-other-"));
  writeFileSync(join(otherDir, "secret.md"), "# Secret\ntop secret");
  const cfg = ServerConfigSchema.parse({
    vaults: [
      { id: "main", path: mainDir },
      { id: "other", path: otherDir },
    ],
  });
  return new VaultRegistry(cfg.vaults);
}

function ctx(scopes: string[], acl?: FolderAcl): CallerContext {
  return {
    caller: "t",
    authenticated: true,
    grantedScopes: new Set(scopes),
    vaultId: "main",
    db: undefined as unknown as Database,
    acl,
  };
}

describe("resource URIs", () => {
  it("round-trips and rejects foreign / malformed schemes", () => {
    expect(buildResourceUri("main", "a/b.md")).toBe("obsidian-tc://main/a/b.md");
    expect(parseResourceUri("obsidian-tc://main/a/b.md")).toEqual({
      vaultId: "main",
      relPath: "a/b.md",
    });
    expect(() => parseResourceUri("file:///etc/passwd")).toThrow();
    expect(() => parseResourceUri("obsidian-tc://main")).toThrow();
  });
});

describe("listResources", () => {
  it("lists every readable .md (skipping dot-dirs) with obsidian-tc:// URIs", () => {
    const res = listResources(tempVault(), ctx(["*"]));
    expect(res.resources.map((r) => r.name).sort()).toEqual(["alpha.md", "sub/beta.md"]);
    expect(res.resources[0]?.uri.startsWith("obsidian-tc://main/")).toBe(true);
    expect(res.resources[0]?.mimeType).toBe("text/markdown");
  });
  it("returns nothing without the read:notes scope", () => {
    expect(listResources(tempVault(), ctx(["write:notes"])).resources).toHaveLength(0);
  });
});

describe("readResource", () => {
  it("reads a note's raw markdown", () => {
    const out = readResource(tempVault(), ctx(["*"]), "obsidian-tc://main/alpha.md");
    const c = out.contents[0];
    expect(c?.uri).toBe("obsidian-tc://main/alpha.md");
    if (!c || !("text" in c)) throw new Error("expected text contents");
    expect(c.text).toBe("# Alpha\nhello");
  });
  it("rejects a path that escapes the vault root", () => {
    expect(() =>
      readResource(tempVault(), ctx(["*"]), "obsidian-tc://main/../escape.md"),
    ).toThrow();
  });
  it("rejects without the read:notes scope", () => {
    expect(() => readResource(tempVault(), ctx([]), "obsidian-tc://main/alpha.md")).toThrow(
      /read:notes/,
    );
  });
  it("rejects a URI pointing at a vault the caller is not bound to", () => {
    // Caller bound to "main" (ctx.vaultId) must not read "other" even with full scope.
    expect(() =>
      readResource(tempMultiVault(), ctx(["*"]), "obsidian-tc://other/secret.md"),
    ).toThrow(/bound vault/);
  });
});

describe("prompts", () => {
  it("lists built-in prompts", () => {
    const names = listPrompts().prompts.map((p) => p.name);
    expect(names).toContain("summarize_note");
    expect(names).toContain("find_connections");
  });
  it("renders a prompt with its argument", () => {
    const r = getPrompt("summarize_note", { path: "projects/x.md" });
    const m = r.messages[0];
    expect(m?.role).toBe("user");
    if (!m || m.content.type !== "text") throw new Error("expected a text message");
    expect(m.content.text).toContain("projects/x.md");
  });
  it("throws on an unknown prompt or a missing required arg", () => {
    expect(() => getPrompt("nope", {})).toThrow();
    expect(() => getPrompt("summarize_note", {})).toThrow(/path/);
  });
  it("rejects a required arg provided as an empty string", () => {
    expect(() => getPrompt("summarize_note", { path: "" })).toThrow(/path/);
  });
});
