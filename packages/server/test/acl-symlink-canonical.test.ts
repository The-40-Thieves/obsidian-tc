import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { enforcePathAcl } from "../src/vault/acl-path";

let symlinkOk = true;
try {
  const probe = mkdtempSync(join(tmpdir(), "sl-probe-"));
  symlinkSync(join(probe, "t"), join(probe, "l"), "dir");
  rmSync(probe, { recursive: true, force: true });
} catch {
  symlinkOk = false; // Windows without the privilege to create symlinks
}

describe.skipIf(!symlinkOk)("THE-269 symlink ACL canonicalization", () => {
  it("denies a read through an in-vault symlink into a non-whitelisted folder", () => {
    const root = mkdtempSync(join(tmpdir(), "vault-"));
    mkdirSync(join(root, "public"));
    mkdirSync(join(root, "secret"));
    writeFileSync(join(root, "secret", "creds.md"), "api_key: x");
    writeFileSync(join(root, "public", "note.md"), "x");
    symlinkSync(join(root, "secret"), join(root, "public", "escape"), "dir");
    const acl = new FolderAcl({
      readOnly: false,
      defaultScopes: [],
      rules: [],
      readPaths: ["public/**"],
    });
    // Lexically public/escape/creds.md matches public/**, but its realpath is secret/creds.md.
    expect(() => enforcePathAcl(acl, "read", "public/escape/creds.md", root)).toThrow();
    // A genuine in-whitelist path is still allowed.
    expect(() => enforcePathAcl(acl, "read", "public/note.md", root)).not.toThrow();
    // The old no-root lexical bypass is no longer expressible: `root` is now a required arg
    // (THE-286), so enforcement always canonicalizes and the symlinked path above is denied.
    rmSync(root, { recursive: true, force: true });
  });
});
