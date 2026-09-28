// `obsidian-tc setup`'s writer — crash-mid-write proof (fix round, Codex review 1001-verify: "the
// 'atomic' test only checks that no temp remains after a successful rename; a direct non-atomic
// write would also pass"). Own file because `vi.mock` is hoisted per-module — every other
// setup-write test needs the REAL fs (see perf-collectors-lock-cleanup.test.ts's own header for
// why this split exists).
//
// Injects a failing finalization step (renameSync for --force, linkSync for the no-force path) —
// the point at which real data has already reached the temp file but has NOT yet reached the real
// target — and proves the pre-existing config at the target is untouched byte-for-byte, and that
// the leftover temp file is cleaned up rather than left as litter.
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rmTemp } from "./tmp";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: vi.fn(() => {
      const e = new Error("ENOSPC: no space left on device, rename") as NodeJS.ErrnoException;
      e.code = "ENOSPC";
      throw e;
    }),
    linkSync: vi.fn(() => {
      const e = new Error("ENOSPC: no space left on device, link") as NodeJS.ErrnoException;
      e.code = "ENOSPC";
      throw e;
    }),
  };
});

const tmpDirs: string[] = [];
const tmpDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmTemp(d);
    } catch {
      /* best-effort */
    }
  }
});

describe("writeSetupConfig — crash mid-write leaves the old file intact", () => {
  it("--force: a failing renameSync leaves the pre-existing config byte-for-byte unchanged, no temp litter", async () => {
    const { writeSetupConfig } = await import("../src/cli/setup/write");
    const dir = tmpDir("otc-setup-write-crash-force-");
    const target = join(dir, "config.json");
    const original = JSON.stringify({ existing: true, marker: "original" });
    writeFileSync(target, original);

    const decision = {
      vaults: [{ id: "main", path: "/vault" }],
      cacheDir: dir,
      embeddings: {
        provider: "local" as const,
        model: "nomic-embed-text-v1.5",
        dimensions: 768,
        reason: "test",
      },
      hostedSuggestions: [],
    };

    expect(() => writeSetupConfig(target, decision, { force: true })).toThrow(/ENOSPC/);

    // The real target is EXACTLY the pre-crash bytes — never partially overwritten.
    expect(readFileSync(target, "utf8")).toBe(original);
    // No leftover .tmp-* file from the failed write.
    const leftovers = readdirSync(dir).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);

    const { renameSync } = await import("node:fs");
    expect(vi.mocked(renameSync)).toHaveBeenCalled();
  });

  it("no --force: a failing linkSync on a fresh target leaves no config and no temp litter", async () => {
    const { writeSetupConfig } = await import("../src/cli/setup/write");
    const dir = tmpDir("otc-setup-write-crash-noforce-");
    const target = join(dir, "config.json");

    const decision = {
      vaults: [{ id: "main", path: "/vault" }],
      cacheDir: dir,
      embeddings: {
        provider: "local" as const,
        model: "nomic-embed-text-v1.5",
        dimensions: 768,
        reason: "test",
      },
      hostedSuggestions: [],
    };

    expect(() => writeSetupConfig(target, decision)).toThrow(/ENOSPC/);
    expect(existsSync(target)).toBe(false);
    const leftovers = readdirSync(dir).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);

    const { linkSync } = await import("node:fs");
    expect(vi.mocked(linkSync)).toHaveBeenCalled();
  });
});
