// `obsidian-tc setup`'s writer — cross-filesystem/cross-platform finalization fallbacks (fix round
// 2, Codex review 1001-verify-r2, findings 5 + Windows CI). Own file for the same `vi.mock`
// isolation reason setup-write-crash.test.ts / setup-write-toctou.test.ts document.
//
// Finding 5 (MEDIUM): `linkSync`'s same-directory hard link (the no-`--force` exclusive-create
// primitive) can fail with EPERM/EXDEV/ENOTSUP/ENOSYS on exFAT, SMB/CIFS home directories, some NAS
// mounts, and some Windows volumes — it must fall back to an exclusive `wx` create-and-copy rather
// than hard-fail the whole command on a box that simply cannot hard-link there.
//
// Windows CI (macOS/windows fix round): `--force`'s `renameSync` over an EXISTING target can fail
// with EPERM on Windows when that target carries the read-only attribute (this writer's own 0o600
// mode, or an operator's own chmod) — reproduced directly in CI (windows-latest,
// `setup-write.test.ts` "--force preserves a STRICTER existing mode"). Must clear read-only and
// retry, or fall back to copying the temp file's bytes over the target in place, rather than fail
// the whole write after the pre-write backup has already been made.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SetupDecision } from "../src/cli/setup/decide";
import { rmTemp } from "./tmp";

// Fix round 2 (finding 4): the no-`--force` exclusive-create fallback now ALSO finalizes via
// `renameSync` (moving an already-staged, complete file onto `target` — write.ts's own header on
// `finalizeExclusiveCreate`), so a `renameSync` that fails UNCONDITIONALLY would now break that
// fallback too, not just the `--force` path finding 5/Windows-CI originally targeted this mock
// for. `renameShouldFail` lets each test opt in to the EPERM only where it means to exercise it.
// Setup hardening item 4: `renameShouldFail = true` still means "always" (persistent EPERM,
// exhausting `finalizeForceWrite`'s retry budget) for backward compat with the existing tests
// below; a NUMBER means "fail exactly this many times, then succeed" — the transient-lock shape
// (a Windows AV/indexer scan that clears within a few retries) the retry loop exists for.
let renameShouldFail: boolean | number = true;

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    linkSync: vi.fn(() => {
      const e = new Error("EXDEV: cross-device link not permitted, link") as NodeJS.ErrnoException;
      e.code = "EXDEV";
      throw e;
    }),
    renameSync: vi.fn((from: string, to: string) => {
      const shouldFailNow =
        renameShouldFail === true || (typeof renameShouldFail === "number" && renameShouldFail > 0);
      if (shouldFailNow) {
        if (typeof renameShouldFail === "number") renameShouldFail -= 1;
        const e = new Error("EPERM: operation not permitted, rename") as NodeJS.ErrnoException;
        e.code = "EPERM";
        throw e;
      }
      return actual.renameSync(from, to);
    }),
    fchmodSync: vi.fn(actual.fchmodSync),
    openSync: vi.fn(actual.openSync),
  };
});

const tmpDirs: string[] = [];
const tmpDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};
afterEach(() => {
  renameShouldFail = true;
  for (const d of tmpDirs.splice(0)) {
    try {
      rmTemp(d);
    } catch {
      /* best-effort */
    }
  }
});

function decision(): SetupDecision {
  return {
    vaults: [{ id: "main", path: "/vault" }],
    cacheDir: "/tmp/otc-cache",
    embeddings: {
      provider: "local",
      model: "nomic-embed-text-v1.5",
      dimensions: 768,
      reason: "test",
    },
    hostedSuggestions: [],
  };
}

describe("writeSetupConfig — cross-filesystem/platform finalization fallbacks", () => {
  it("no --force: linkSync unsupported (EXDEV) falls back to an exclusive create-and-copy instead of failing the write", async () => {
    const { writeSetupConfig } = await import("../src/cli/setup/write");
    const dir = tmpDir("otc-setup-write-linkfallback-");
    const target = join(dir, "config.json");
    // This fallback's own finalization step (marker + staged file + `renameSync`) is real here —
    // only the SECOND test below means to exercise a renameSync failure.
    renameShouldFail = false;

    const result = writeSetupConfig(target, decision());

    expect(result.path).toBe(target);
    const onDisk = JSON.parse(readFileSync(target, "utf8"));
    expect(onDisk.vaults).toEqual([{ id: "main", path: "/vault" }]);
    const { linkSync } = await import("node:fs");
    expect(vi.mocked(linkSync)).toHaveBeenCalled();
  });

  it("--force: a PERSISTENT renameSync EPERM (Windows read-only attribute / sharing violation) exhausts the retry budget, then falls back to copying over the target instead of failing after the backup is already made", async () => {
    const { writeSetupConfig } = await import("../src/cli/setup/write");
    const dir = tmpDir("otc-setup-write-renamefallback-");
    const target = join(dir, "config.json");
    writeFileSync(target, JSON.stringify({ existing: true }));

    const result = writeSetupConfig(target, decision(), { force: true });

    expect(result.backupPath).toBeDefined();
    const onDisk = JSON.parse(readFileSync(target, "utf8"));
    expect(onDisk.existing).toBeUndefined();
    expect(onDisk.vaults).toEqual([{ id: "main", path: "/vault" }]);
    const { renameSync, openSync } = await import("node:fs");
    // Setup hardening item 4: proves the RETRY LOOP actually ran to exhaustion (more than the old
    // single-retry behavior) before falling back — not just "renameSync was called at all".
    expect(vi.mocked(renameSync).mock.calls.length).toBeGreaterThan(2);
    // And that the fallback really is the non-atomic copy-in-place (`openSync(target, "w", ...)`)
    // — the one call shape unique to it, vs. every other `wx` exclusive-create in this module.
    const copyOpen = vi.mocked(openSync).mock.calls.some((c) => c[0] === target && c[1] === "w");
    expect(copyOpen).toBe(true);
  });

  // Setup hardening item 4: the transient shape the retry loop exists for — a brief Windows AV/
  // indexer lock that clears within a few attempts — must recover via `renameSync` itself, WITHOUT
  // ever falling back to the non-atomic copy-in-place.
  it("--force: a TRANSIENT renameSync EPERM (fails twice, then succeeds) recovers via retry, never falling back to copying in place", async () => {
    const { writeSetupConfig } = await import("../src/cli/setup/write");
    const dir = tmpDir("otc-setup-write-renametransient-");
    const target = join(dir, "config.json");
    writeFileSync(target, JSON.stringify({ existing: true }));
    renameShouldFail = 2; // fails on attempts 1 and 2, succeeds on attempt 3

    const result = writeSetupConfig(target, decision(), { force: true });

    expect(result.backupPath).toBeDefined();
    const onDisk = JSON.parse(readFileSync(target, "utf8"));
    expect(onDisk.existing).toBeUndefined();
    expect(onDisk.vaults).toEqual([{ id: "main", path: "/vault" }]);
    const { renameSync, openSync } = await import("node:fs");
    expect(vi.mocked(renameSync).mock.calls.length).toBe(3);
    const copyOpen = vi.mocked(openSync).mock.calls.some((c) => c[0] === target && c[1] === "w");
    expect(copyOpen).toBe(false);
  });

  // Setup hardening item 4: when EVERY fallback is exhausted (retries AND the copy-in-place last
  // resort both fail), the thrown error must NAME the backup so an operator can recover by hand —
  // this is `finalizeForceWriteNamingBackup`'s own contract, exercised end to end here for the
  // first time via the retry path.
  it("--force: when both the retried rename AND the copy-in-place fallback fail, the error names the backup path", async () => {
    const { writeSetupConfig } = await import("../src/cli/setup/write");
    const dir = tmpDir("otc-setup-write-totalfailure-");
    const target = join(dir, "config.json");
    writeFileSync(target, JSON.stringify({ existing: true }));
    const { openSync } = await import("node:fs");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    // Fail ONLY copyOverInPlace's own truncating `openSync(target, "w", ...)` — every other
    // openSync in this module (temp file, backup file — both "wx") must still work for real, or
    // the write would fail somewhere else entirely and this test would prove nothing about the
    // fallback path it targets.
    vi.mocked(openSync).mockImplementation(
      (path: Parameters<typeof actualFs.openSync>[0], flags?: unknown, mode?: unknown) => {
        if (path === target && flags === "w") {
          throw Object.assign(new Error("EACCES: permission denied, open"), { code: "EACCES" });
        }
        return actualFs.openSync(
          path,
          flags as Parameters<typeof actualFs.openSync>[1],
          mode as Parameters<typeof actualFs.openSync>[2],
        );
      },
    );

    let thrown: unknown;
    try {
      writeSetupConfig(target, decision(), { force: true });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toMatch(/\.bak-/);
    // The pre-write backup itself really is on disk — the error names something real, not a path
    // that never got created.
    const backupMatch = message.match(/(\S+\.bak-\S+)/);
    expect(backupMatch).not.toBeNull();
    const backupPath = (backupMatch?.[1] ?? "").replace(/[).,]+$/, "");
    expect(existsSync(backupPath)).toBe(true);
  });

  // Security addendum (automated review, fix round 2): `copyOverInPlace`'s `openSync(target, "w",
  // mode)` only applies `mode` when the open call CREATES the file — here `target` already exists,
  // so its OLD, possibly looser permissions would otherwise sit on the NEW content (which may carry
  // real secrets: auth.jwtSecret, an inline embeddings.apiKey) for as long as it takes
  // `writeSetupConfig`'s own unconditional END-of-function `chmodSync` to run. `copyOverInPlace`
  // must tighten the mode on the OPEN FD itself (`fchmodSync`) BEFORE writing the new content —
  // closing that window at the source, not just fixing the end state up a moment later. POSIX-only
  // — Windows has no POSIX mode bits (see setup-write.test.ts's own
  // `describe.skipIf(process.platform === "win32")` convention for the same reason); `fchmodSync`
  // is still called there (best-effort, never fatal), just not meaningfully assertable.
  (process.platform === "win32" ? it.skip : it)(
    "--force: the EPERM-rename fallback tightens an existing looser mode via fchmodSync on the open fd, not only the end-of-write chmodSync",
    async () => {
      const { writeSetupConfig } = await import("../src/cli/setup/write");
      const dir = tmpDir("otc-setup-write-renamefallback-mode-");
      const target = join(dir, "config.json");
      writeFileSync(target, JSON.stringify({ existing: true }), { mode: 0o644 });

      writeSetupConfig(target, decision(), { force: true });

      const { fchmodSync, statSync } = await import("node:fs");
      expect(vi.mocked(fchmodSync)).toHaveBeenCalledWith(expect.any(Number), 0o600);
      expect(statSync(target).mode & 0o777).toBe(0o600);
    },
  );
});
