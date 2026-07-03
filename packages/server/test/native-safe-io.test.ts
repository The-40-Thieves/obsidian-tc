// THE-272: the native symlink-safe open closes the intermediate-directory symlink-swap TOCTOU that
// the pure-JS fd path cannot (readNote/writeNoteAtomic route through it when the compiled module is
// loaded). These tests exercise that path directly. They skip when the native module is absent (the
// pure-JS fallback retains the documented residual) and when the host cannot create a symlink
// (Windows without admin/developer mode) — so the symlink-rejection assertions run on Linux/macOS CI
// where the native module is built and symlinks are freely creatable.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nativeVaultIo, readNote, writeNoteAtomic } from "../src/vault/notes-io";

/** Try to create a symlink; return false if the host forbids it (Windows without privilege). */
function trySymlink(target: string, link: string, type: "dir" | "file"): boolean {
  try {
    symlinkSync(target, link, type);
    return true;
  } catch {
    return false;
  }
}

describe("THE-272 native symlink-safe vault I/O", () => {
  it("reads a normal note through the native path", () => {
    if (!nativeVaultIo) return;
    const root = mkdtempSync(join(tmpdir(), "otc-safe-"));
    try {
      writeFileSync(join(root, "note.md"), "hello native\n");
      expect(readNote(join(root, "note.md")).raw).toBe("hello native\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes atomically through the native path (nested dir)", () => {
    if (!nativeVaultIo) return;
    const root = mkdtempSync(join(tmpdir(), "otc-safe-"));
    try {
      writeNoteAtomic(join(root, "sub", "note.md"), "written\n", true);
      expect(readFileSync(join(root, "sub", "note.md"), "utf8")).toBe("written\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to read a note whose ANCESTOR directory is a symlink", () => {
    if (!nativeVaultIo) return;
    const root = mkdtempSync(join(tmpdir(), "otc-toctou-"));
    const outside = mkdtempSync(join(tmpdir(), "otc-outside-"));
    try {
      // Attacker plants a secret outside and swaps `sub` for a symlink to it.
      writeFileSync(join(outside, "note.md"), "SECRET\n");
      if (!trySymlink(outside, join(root, "sub"), "dir")) return; // no symlink privilege — skip
      // Lexical root/sub/note.md now resolves through the symlink to outside/note.md. The native
      // safe read must refuse the symlinked ancestor, not serve the SECRET.
      expect(() => readNote(join(root, "sub", "note.md"))).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses to read a note that is itself a symlink", () => {
    if (!nativeVaultIo) return;
    const root = mkdtempSync(join(tmpdir(), "otc-toctou-"));
    const outside = mkdtempSync(join(tmpdir(), "otc-outside-"));
    try {
      writeFileSync(join(outside, "secret.md"), "SECRET\n");
      mkdirSync(join(root, "pub"));
      if (!trySymlink(join(outside, "secret.md"), join(root, "pub", "link.md"), "file")) return;
      expect(() => readNote(join(root, "pub", "link.md"))).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
