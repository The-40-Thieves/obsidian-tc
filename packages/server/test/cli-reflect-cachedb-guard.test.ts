// THE-726 fix round 3 (G5): `run_reflect` opens cache.db, moved (round 3) INSIDE the derive step's
// own try/catch. Round 1 opened it unconditionally before that guard, so an unreadable or corrupt
// cache.db aborted the whole command before evaluateEpisodes ever ran - a regression from before
// this pass existed, when `citationPreferences` off meant eligibility never touched cache.db at
// all. `run_reflect` has no subprocess-free existing coverage (cli-smoke.test.ts only spawns the
// real binary, for commands that need no fixture beyond a bare config), so this drives the
// extracted function directly rather than adding a slow subprocess case for one guard.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run_reflect } from "../src/cli/commands/reflect";
import type { Cmd } from "../src/cli/shared";
import { rmTemp } from "./tmp";

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "obtc-cli-reflect-"));
  const vaultPath = join(dir, "vault");
  mkdirSync(vaultPath, { recursive: true });
  const cfg = {
    vaults: [{ id: "main", path: vaultPath }],
    cacheDir: join(dir, "cache"),
  };
  configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify(cfg, null, 2));
});

afterEach(() => {
  try {
    rmTemp(dir);
  } catch {
    // best-effort cleanup; see tmp.ts's own note on why this can legitimately fail on Windows
  }
});

describe("run_reflect: cache.db open failure (THE-726 fix round 3)", () => {
  it("does not abort the command - prints the same failure line and still runs eligibility", async () => {
    // A garbage file at the exact cache.db path: `openDatabase` throws "file is not a database"
    // (or equivalent) opening it, the same failure shape as a corrupt/unreadable file on disk.
    const cacheDir = join(dir, "cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "cache.db"), "not a sqlite file, deliberately corrupt");

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrChunks.push(String(chunk));
      return true;
    });
    try {
      await run_reflect({ kind: "reflect", input: configPath } as Cmd<"reflect">);
    } finally {
      // THE-726 fix round 3: `mockRestore()` also RESETS the recorded call history (it is
      // `mockReset()` plus restoring the original implementation) - capturing into `stdoutChunks`/
      // `stderrChunks` inside the mock implementation itself, above, is what survives this call.
      // Reading `.mock.calls` here (after restore) would silently see zero calls every time.
      stdout.mockRestore();
      stderr.mockRestore();
    }

    const out = stdoutChunks.join("");
    const err = stderrChunks.join("");
    expect(err).toContain("reflect: derived-verdict pass failed");
    // The eligibility line printed anyway - round 1's regression aborted BEFORE this ever ran.
    expect(out).toContain("reflect: scanned=");
    expect(out).toContain("reflect: derived-verdict pass failed (see stderr)");
  });
});
