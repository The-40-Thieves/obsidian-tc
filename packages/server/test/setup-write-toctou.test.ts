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
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempDir, rmTemp } from "./tmp";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    // Passes through to the real linkSync by default — item 3 (setup hardening) overrides this
    // per-test (mockImplementationOnce) to simulate a filesystem where hard links are unavailable
    // (ENOTSUP/EPERM/EXDEV), forcing `finalizeExclusiveCreate`'s `.wx-claim` marker fallback so
    // THAT path gets the same TOCTOU proof the hard-link path already had — previously only the
    // hard-link branch was ever exercised here.
    linkSync: vi.fn(actual.linkSync),
  };
});

const tmpDirs: string[] = [];
const tmpDir = (prefix: string): string => {
  const d = makeTempDir(prefix);
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

  // Setup hardening item 3: the SAME proof, but on a filesystem where `linkSync` itself is
  // unavailable (ENOTSUP — also covers EPERM/EXDEV, handled identically by
  // `finalizeExclusiveCreate`) — the real guard then shifts to the `.wx-claim` marker's own
  // exclusive `openSync(marker, "wx")`, not `existsSync` (still mocked to lie here, exactly like
  // the hard-link case above). A LIVE marker (fresh pid + timestamp) simulates a concurrent
  // obsidian-tc process that is, right now, atomically mid-write — the one race the marker
  // mechanism exists to catch, since (unlike a target file written by some unrelated process) two
  // writers on the SAME hardlink-incapable filesystem both fall to this exact mechanism.
  it("a live concurrent marker claim is never clobbered when linkSync is unavailable and existsSync itself reports absent", async () => {
    const { writeSetupConfig } = await import("../src/cli/setup/write");
    const { linkSync } = await import("node:fs");
    // `Once`: falls back to the module factory's own `actual.linkSync` on any later call, so this
    // test needs no manual restore and can never leak the override into a later test.
    vi.mocked(linkSync).mockImplementationOnce(() => {
      const e = new Error("ENOTSUP: hard links not supported") as NodeJS.ErrnoException;
      e.code = "ENOTSUP";
      throw e;
    });
    const dir = tmpDir("otc-setup-write-toctou-marker-");
    const target = join(dir, "config.json");
    const marker = `${target}.wx-claim`;
    const markerContent = JSON.stringify({ pid: process.pid, ts: Date.now() });
    writeFileSync(marker, markerContent);

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

    expect(() => writeSetupConfig(target, decision)).toThrow(/already in progress/);
    // Nothing this call did was allowed to land: no target, the other holder's own marker is
    // untouched (never treated as stale/reclaimable — this process is alive, ts is fresh), and no
    // temp/staged litter of our own.
    expect(readFileSync(marker, "utf8")).toBe(markerContent);
    const leftovers = readdirSync(dir).filter(
      (f) => f.includes(".tmp-") || f.includes(".wx-stage-"),
    );
    expect(leftovers).toEqual([]);
    expect(readdirSync(dir)).not.toContain("config.json");
  });
});
