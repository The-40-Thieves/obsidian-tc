// filesystemIdentity: the dev:ino of a vault path after symlinks. Equal exactly when two spellings
// name one file, which is what a rename needs to tell "the same note" from "a different note".
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { filesystemIdentity } from "../src/vault/fs-identity";
import { makeTempDir, rmTemp } from "./tmp";

describe("filesystemIdentity", () => {
  let root: string;
  beforeEach(() => {
    root = makeTempDir("fs-identity-");
    mkdirSync(join(root, "memory"), { recursive: true });
    writeFileSync(join(root, "memory", "A.md"), "a");
    writeFileSync(join(root, "memory", "B.md"), "b");
  });
  afterEach(() => rmTemp(root));

  it.skipIf(process.platform === "win32")("one file through two spellings is equal", () => {
    symlinkSync(join(root, "memory", "A.md"), join(root, "memory", "Alias.md"));
    const direct = filesystemIdentity(root, "memory/A.md");
    expect(direct).not.toBeNull();
    expect(filesystemIdentity(root, "memory/Alias.md")).toBe(direct);
  });

  it("two different files are not equal", () => {
    const a = filesystemIdentity(root, "memory/A.md");
    const b = filesystemIdentity(root, "memory/B.md");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });

  it("a missing file has no identity", () => {
    expect(filesystemIdentity(root, "memory/Missing.md")).toBeNull();
  });
});
