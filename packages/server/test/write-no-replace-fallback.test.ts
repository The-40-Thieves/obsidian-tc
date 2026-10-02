// The no-replace create on a filesystem without hard links (FAT/exFAT, some network mounts) reserves
// the name with an O_EXCL placeholder and renames the temp file over it. If that rename fails the
// placeholder is ours and must go: it must not stay behind as a zero-byte note.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stageNoteWrite } from "../src/vault/notes-io";
import { makeTempDir, rmTemp } from "./tmp";

const fsSeam = vi.hoisted(() => {
  // The JS writer is the one that has the fallback; the native one never reaches it.
  process.env.OBSIDIAN_TC_FORCE_JS_FALLBACK = "1";
  return { failRenameTo: undefined as string | undefined };
});
vi.mock("node:fs", async (orig) => {
  const actual = await orig<typeof import("node:fs")>();
  const eperm = (): never => {
    throw Object.assign(new Error("EPERM: operation not permitted, link"), { code: "EPERM" });
  };
  return {
    ...actual,
    linkSync: eperm,
    renameSync: (from: string, to: string) => {
      if (fsSeam.failRenameTo === to) throw new Error("rename failed");
      return actual.renameSync(from, to);
    },
  };
});

let dir: string;
beforeEach(() => {
  dir = makeTempDir("otc-no-replace-fallback-");
});
afterEach(() => {
  fsSeam.failRenameTo = undefined;
  rmTemp(dir);
});

describe("no-replace create without hard links", () => {
  it("creates the note", () => {
    stageNoteWrite(join(dir, "p.md"), "page", true, { exclusive: true }).commit();
    expect(existsSync(join(dir, "p.md"))).toBe(true);
  });

  it("a failed rename leaves neither the placeholder nor the temp file", () => {
    const target = join(dir, "p.md");
    fsSeam.failRenameTo = target;
    const s = stageNoteWrite(target, "page", true, { exclusive: true });
    expect(() => s.commit()).toThrow("rename failed");
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });
});
