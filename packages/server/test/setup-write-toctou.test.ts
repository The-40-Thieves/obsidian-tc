// `obsidian-tc setup`'s writer — TOCTOU proof (fix round, Codex review 1001-verify finding 6): "Two
// writers can both observe an absent target. On POSIX, the second renameSync replaces the file
// created by the first even though neither used --force." Own file for the same `vi.mock`
// isolation reason setup-write-crash.test.ts documents.
//
// Mocks `existsSync` to LIE — always report "absent" — simulating a check that ran before a
// concurrent writer's file appeared. The real guard against a race is `writeSetupConfig`'s
// exclusive `linkSync` at finalization time, not the earlier `existsSync` read; this proves the
// write still fails (and the raced-in file is left untouched) even when the early check is
// useless.
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rmTemp } from "./tmp";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
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

describe("writeSetupConfig — TOCTOU: the real guard is exclusive linkSync, not existsSync", () => {
  it("a raced-in target is never clobbered even when existsSync itself reports absent", async () => {
    const { writeSetupConfig } = await import("../src/cli/setup/write");
    const dir = tmpDir("otc-setup-write-toctou-");
    const target = join(dir, "config.json");
    const raced = JSON.stringify({ raced: true });
    writeFileSync(target, raced); // the "concurrent writer" that already landed

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

    // existsSync says "nothing there" (mocked false), yet the write must still refuse — linkSync
    // itself hits EEXIST against the real filesystem.
    expect(() => writeSetupConfig(target, decision)).toThrow(/already exists/);
    expect(readFileSync(target, "utf8")).toBe(raced);
    const leftovers = readdirSync(dir).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });
});
