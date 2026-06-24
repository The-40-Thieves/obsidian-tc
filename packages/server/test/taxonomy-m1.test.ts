import {
  AclConfigSchema,
  err,
  ObsidianTcError,
  VaultId,
  VaultPath,
} from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";

describe("M1 error taxonomy", () => {
  it("exposes the new G2.1 codes and serializes them", () => {
    const e = err.aclDenied("nope", { path: "x.md", op: "write" });
    expect(e.toJSON()).toEqual({
      code: "acl_denied",
      message: "nope",
      retryable: false,
      details: { path: "x.md", op: "write" },
    });
  });
  it("marks concurrent_modification retryable, path_ambiguous not", () => {
    expect(new ObsidianTcError("concurrent_modification", "x").retryable).toBe(true);
    expect(new ObsidianTcError("path_ambiguous", "x").retryable).toBe(false);
    expect(new ObsidianTcError("note_not_found", "x").retryable).toBe(false);
  });
});

describe("M1 path primitives", () => {
  it("VaultPath rejects traversal and absolute paths", () => {
    expect(VaultPath.safeParse("notes/a.md").success).toBe(true);
    expect(VaultPath.safeParse("../escape.md").success).toBe(false);
    expect(VaultPath.safeParse("/etc/passwd").success).toBe(false);
    expect(VaultPath.safeParse("C:\\win.md").success).toBe(false);
    expect(VaultPath.safeParse("a/../../b.md").success).toBe(false);
  });
  it("VaultId requires a lowercase slug", () => {
    expect(VaultId.safeParse("personal-vault_1").success).toBe(true);
    expect(VaultId.safeParse("BadVault").success).toBe(false);
  });
});

describe("AclConfig per-path fields", () => {
  it("defaults the path whitelists to undefined (back-compat unrestricted)", () => {
    const c = AclConfigSchema.parse({});
    expect(c.readOnly).toBe(false);
    expect(c.readPaths).toBeUndefined();
    expect(c.writePaths).toBeUndefined();
    expect(c.deletePaths).toBeUndefined();
  });
  it("parses provided path whitelists", () => {
    const c = AclConfigSchema.parse({ writePaths: ["notes/**"], deletePaths: [] });
    expect(c.writePaths).toEqual(["notes/**"]);
    expect(c.deletePaths).toEqual([]);
  });
});
