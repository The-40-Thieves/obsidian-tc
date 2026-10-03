// `vaults[].wiki.rawFolder`: where a vault's immutable raw sources live. Validated with the same
// rules as `wiki.folder` (schema AND a registry built in code), defaulted to `raw` BESIDE the wiki
// folder, and never allowed to overlap it. buildAcls turns it into the vault's immutable paths.
import { VaultConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { aclFingerprint, type FolderAcl } from "../src/acl";
import { buildAcls } from "../src/runtime/acl-build";
import { evaluatePathAcl } from "../src/vault/acl-path";
import { defaultRawFolder, rawFolderOf } from "../src/vault/raw-folder";
import { VaultRegistry } from "../src/vault/registry";

const parse = (wiki: Record<string, unknown>) =>
  VaultConfigSchema.safeParse({ id: "a", path: "/x", wiki });
const raw = (wiki: { folder: string; rawFolder?: string }) =>
  new VaultRegistry([{ id: "a", path: "/tmp", wiki }]).resolve("a").rawFolder;

describe("wiki.rawFolder: the default sits beside the wiki folder", () => {
  it("is `raw` next to the wiki folder, at any depth", () => {
    expect(raw({ folder: "wiki" })).toBe("raw");
    expect(raw({ folder: "notes/wiki" })).toBe("notes/raw");
    expect(raw({ folder: "a/b/c" })).toBe("a/b/raw");
  });

  it("is none when `raw` would be the wiki folder itself (a wiki folder named raw)", () => {
    expect(defaultRawFolder("raw")).toBeUndefined();
    expect(defaultRawFolder("Raw")).toBeUndefined();
    expect(defaultRawFolder("notes/raw")).toBeUndefined();
    expect(raw({ folder: "raw" })).toBeUndefined();
    // Beside a wiki folder that sits inside one called raw is still a sibling of it.
    expect(defaultRawFolder("raw/wiki")).toBe("raw/raw");
  });

  it("is none for a vault with no wiki folder", () => {
    expect(new VaultRegistry([{ id: "a", path: "/tmp" }]).resolve("a").rawFolder).toBeUndefined();
  });

  it("an explicit value wins, exactly as written", () => {
    expect(raw({ folder: "wiki", rawFolder: "sources/clips" })).toBe("sources/clips");
  });

  it("is an optional key; the schema keeps what was written", () => {
    expect(VaultConfigSchema.parse({ id: "a", path: "/x", wiki: { folder: "wiki" } }).wiki).toEqual(
      {
        folder: "wiki",
      },
    );
    expect(
      VaultConfigSchema.parse({ id: "a", path: "/x", wiki: { folder: "wiki", rawFolder: "src" } })
        .wiki,
    ).toEqual({ folder: "wiki", rawFolder: "src" });
  });
});

describe("wiki.rawFolder: validated like wiki.folder", () => {
  for (const rawFolder of [
    "",
    ".",
    "/",
    "..",
    "./",
    "/raw",
    "raw/",
    "raw//sub",
    "a/../b",
    "../raw",
    "raw/./x",
    "C:\\raw",
    "C:/raw",
    "raw\\sub",
    "raw\0",
  ]) {
    it(`the schema rejects ${JSON.stringify(rawFolder)}`, () => {
      expect(parse({ folder: "wiki", rawFolder }).success).toBe(false);
    });
    it(`the registry refuses ${JSON.stringify(rawFolder)} instead of reinterpreting it`, () => {
      expect(() => raw({ folder: "wiki", rawFolder })).toThrow(/wiki\.rawFolder/);
    });
  }
});

describe("wiki.rawFolder: never overlaps the wiki folder", () => {
  const overlaps: Array<[string, string]> = [
    ["wiki", "wiki"],
    ["wiki", "Wiki"],
    ["notes/wiki", "notes/wiki/raw"],
    ["notes/wiki", "notes"],
    ["wiki", "wiki/sources"],
  ];
  for (const [folder, rawFolder] of overlaps) {
    it(`rejects folder ${folder} with rawFolder ${rawFolder}`, () => {
      const r = parse({ folder, rawFolder });
      expect(r.success).toBe(false);
      expect(() => raw({ folder, rawFolder })).toThrow(/must not be, contain or sit inside/);
    });
  }

  it("a sibling that merely shares a prefix is fine", () => {
    expect(parse({ folder: "wiki", rawFolder: "wiki-raw" }).success).toBe(true);
    expect(rawFolderOf("a", { folder: "wiki", rawFolder: "wiki-raw" })).toBe("wiki-raw");
  });
});

describe("buildAcls: a vault's raw folder is immutable, whatever its ACL", () => {
  const cfg = { readOnly: false, defaultScopes: [], rules: [] };
  const writesDenied = (acl: FolderAcl | undefined, rel: string): boolean =>
    acl !== undefined &&
    (["write", "delete"] as const).every((op) => !evaluatePathAcl(acl, op, rel).allowed);

  it("gives a wiki vault its own ACL even when it inherits the root config", () => {
    const { aclByVault } = buildAcls(cfg, [{ id: "a", wiki: { folder: "wiki" } }, { id: "b" }]);
    expect([...aclByVault.keys()]).toEqual(["a"]);
    const a = aclByVault.get("a");
    expect(writesDenied(a, "raw/clip.md")).toBe(true);
    expect(writesDenied(a, "raw")).toBe(true);
    expect(writesDenied(a, "raw/deep/er/clip.md")).toBe(true);
    // Only writes: reads and everything else are untouched.
    expect(evaluatePathAcl(a, "read", "raw/clip.md").allowed).toBe(true);
    expect(evaluatePathAcl(a, "write", "wiki/Page.md").allowed).toBe(true);
    expect(evaluatePathAcl(a, "write", "rawish/clip.md").allowed).toBe(true);
    expect(evaluatePathAcl(a, "write", "notes/raw/clip.md").allowed).toBe(true);
  });

  it("keeps the vault's own ACL block and adds the immutable folder to it", () => {
    const own = { ...cfg, writePaths: ["raw/**", "wiki/**"] };
    const { aclByVault } = buildAcls(cfg, [{ id: "a", acl: own, wiki: { folder: "wiki" } }]);
    const a = aclByVault.get("a");
    // writePaths allows raw/**, and the immutable rule still wins.
    expect(writesDenied(a, "raw/clip.md")).toBe(true);
    expect(evaluatePathAcl(a, "write", "wiki/Page.md").allowed).toBe(true);
    expect(evaluatePathAcl(a, "write", "notes/x.md").allowed).toBe(false);
  });

  it("follows a configured rawFolder, and a vault without a wiki has none", () => {
    const { aclByVault } = buildAcls(cfg, [
      { id: "a", wiki: { folder: "wiki", rawFolder: "sources" } },
      { id: "b" },
    ]);
    const a = aclByVault.get("a");
    expect(writesDenied(a, "sources/x.md")).toBe(true);
    expect(evaluatePathAcl(a, "write", "raw/x.md").allowed).toBe(true);
    expect(aclByVault.has("b")).toBe(false);
  });

  it("the root readOnly switch still applies on top (observe mode)", () => {
    const { aclByVault } = buildAcls({ ...cfg, readOnly: true }, [
      { id: "a", wiki: { folder: "wiki" } },
    ]);
    expect(evaluatePathAcl(aclByVault.get("a"), "write", "wiki/x.md")).toMatchObject({
      allowed: false,
      deniedBy: "read_only",
    });
  });

  it("the fingerprint tells a vault with an immutable folder from one without", () => {
    const withRaw = { ...cfg, immutablePaths: ["raw", "raw/**"] };
    expect(aclFingerprint(withRaw, ["*"])).not.toBe(aclFingerprint(cfg, ["*"]));
    // A vault with none keeps the fingerprint (and persisted acl_path_sets rows) it always had.
    expect(aclFingerprint({ ...cfg, immutablePaths: [] }, ["*"])).toBe(aclFingerprint(cfg, ["*"]));
  });
});
