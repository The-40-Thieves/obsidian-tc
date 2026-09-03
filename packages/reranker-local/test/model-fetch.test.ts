// THE-944 — the fetch/verify/atomic-rename pipeline itself, exercised against a TINY synthetic
// model spec (two small files, not the real ~23 MB onnx export) via an injected fetchFn — never the
// network, never model-info.ts's real pinned files. Fast and fully deterministic; the real
// constants + real network path are proven separately by `bun run fetch-model` (manual/CI) and by
// test/integration.test.ts (skips unless the real weights are already on disk).
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertVerified,
  fetchAndVerifyModel,
  modelDirFor,
  unsupportedPlatformReason,
  verifyModelDir,
} from "../src/model-fetch.js";

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

const A_CONTENT = "hello";
const B_CONTENT = "world-file";
const PINNED = [
  { path: "a.txt", sha256: sha256(A_CONTENT), sizeBytes: Buffer.byteLength(A_CONTENT) },
  { path: "sub/b.txt", sha256: sha256(B_CONTENT), sizeBytes: Buffer.byteLength(B_CONTENT) },
] as const;
const SPEC = { modelId: "acme/tiny-model", revision: "rev1", pinnedFiles: PINNED };

/** A fetchFn stub serving PINNED's real content by URL suffix — the shape every test below starts
 *  from, then mutates (fails N times, serves wrong bytes, ...) to exercise one failure mode. */
function okFetchFn(): typeof fetch {
  return vi.fn(async (url: string | URL) => {
    const u = String(url);
    const content = u.endsWith("a.txt") ? A_CONTENT : u.endsWith("b.txt") ? B_CONTENT : undefined;
    if (content === undefined) return new Response(null, { status: 404 });
    return new Response(content, { status: 200 });
  }) as unknown as typeof fetch;
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "reranker-local-fetch-test-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("modelDirFor", () => {
  it("nests the revision INSIDE the model-id segment: <root>/<model-id>/<revision>", () => {
    expect(modelDirFor(root, SPEC)).toBe(join(root, "acme/tiny-model", "rev1"));
  });
});

describe("verifyModelDir", () => {
  it("reports missing, size-mismatched, sha256-mismatched, and ok, independently per file", async () => {
    const dir = join(root, "d");
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "a.txt"), A_CONTENT); // correct
    await writeFile(join(dir, "sub", "b.txt"), "wrong-bytes-same-len"); // wrong content, size matches accidentally? ensure not
    const results = await verifyModelDir(dir, SPEC);
    const byPath = Object.fromEntries(results.map((r) => [r.file.path, r]));
    expect(byPath["a.txt"]?.ok).toBe(true);
    expect(byPath["sub/b.txt"]?.ok).toBe(false);
    expect(byPath["sub/b.txt"]?.reason).toMatch(/sha256|size/);
  });

  it("reports 'missing' for a file that was never written", async () => {
    const dir = join(root, "empty");
    const results = await verifyModelDir(dir, SPEC);
    expect(results.every((r) => r.ok === false && r.reason === "missing")).toBe(true);
  });
});

// THE-944 test requirement: "fetch verification going red on a corrupted file". A corrupted
// pre-existing cache must NOT be silently accepted — verifyModelDir must flag it, and
// fetchAndVerifyModel must therefore re-fetch rather than serving the corrupted bytes to the
// caller. The MUTATION this test catches: a version of this pipeline that trusted file PRESENCE
// (or size) alone, without the sha256 check, would short-circuit on the corrupted file below and
// never call fetchFn at all — this test fails red under that mutation (fetchFn.mock.calls would be
// empty) and passes green with the real sha256-checking implementation.
describe("fetch verification goes red on a corrupted file", () => {
  it("a pre-existing file with the WRONG content (matching size) is detected as corrupt and re-fetched", async () => {
    // Review round 1 (F6): this MUST write into modelDirFor(root, SPEC) — the exact directory
    // fetchAndVerifyModel(root, ...) reads — not some other `dir`. The first cut wrote to
    // join(root, "cache"), a directory fetchAndVerifyModel never looks at, so its assertions
    // passed because the REAL target was simply empty (missing files), not because a checksum
    // failed — the corruption setup below was dead code. Confirmed by reverting this fix: with
    // the corrupt files back at `join(root, "cache")`, this test still passes even though
    // model-fetch.ts's own sha256 check is fully intact — proof the old path exercised nothing.
    const dir = modelDirFor(root, SPEC);
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "a.txt"), A_CONTENT); // this one is genuinely fine
    // Same byte length as B_CONTENT ("world-file", 10 bytes) so this is caught by the sha256 check,
    // not merely the (weaker) size check — proving the checksum, not just presence/size, gates use.
    await writeFile(join(dir, "sub", "b.txt"), "world-FAKE");
    expect(Buffer.byteLength("world-FAKE")).toBe(Buffer.byteLength(B_CONTENT));

    const preCheck = await verifyModelDir(dir, SPEC);
    expect(preCheck.find((r) => r.file.path === "a.txt")?.ok).toBe(true);
    expect(preCheck.find((r) => r.file.path === "sub/b.txt")?.ok).toBe(false);

    const fetchFn = okFetchFn();
    const finalDir = await fetchAndVerifyModel(root, { ...SPEC, fetchFn });
    expect(finalDir).toBe(dir);
    // Detected as unverified -> re-fetched. fetchFn must be asked for BOTH files, not just the
    // corrupt one — downloadAndVerifyInto re-fetches the whole batch on any single failure (see
    // its own doc comment), so the genuinely-fine a.txt is re-downloaded too, not left in place.
    expect(fetchFn).toHaveBeenCalled();
    const fetchedPaths = (fetchFn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(fetchedPaths.some((u) => u.endsWith("a.txt"))).toBe(true);
    expect(fetchedPaths.some((u) => u.endsWith("b.txt"))).toBe(true);
    const postCheck = await verifyModelDir(finalDir, SPEC);
    expect(postCheck.every((r) => r.ok)).toBe(true);
    // The corrupted content is GONE, not merely shadowed — read it back off disk directly.
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(join(finalDir, "sub", "b.txt"), "utf8")).toBe(B_CONTENT);
  });
});

// THE-944 test requirement: "offline path with a pre-populated cache".
describe("offline path with a pre-populated cache", () => {
  it("touches the network ZERO times when the target directory already verifies clean", async () => {
    const finalDir = modelDirFor(root, SPEC);
    await mkdir(join(finalDir, "sub"), { recursive: true });
    await writeFile(join(finalDir, "a.txt"), A_CONTENT);
    await writeFile(join(finalDir, "sub", "b.txt"), B_CONTENT);

    const fetchFn = vi.fn(async () => {
      throw new Error("network must not be reached — the cache is already verified");
    }) as unknown as typeof fetch;

    const resolved = await fetchAndVerifyModel(root, { ...SPEC, fetchFn });
    expect(resolved).toBe(finalDir);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("fetchAndVerifyModel — download, retry, and atomic rename", () => {
  it("downloads into place via the injected fetchFn, matching the documented <model-id>/<revision> layout", async () => {
    const fetchFn = okFetchFn();
    const finalDir = await fetchAndVerifyModel(root, { ...SPEC, fetchFn });
    expect(finalDir).toBe(modelDirFor(root, SPEC));
    expect(existsSync(join(finalDir, "a.txt"))).toBe(true);
    expect(existsSync(join(finalDir, "sub", "b.txt"))).toBe(true);
    // No leftover staging directory beside the final one.
    const modelIdDir = join(root, "acme", "tiny-model");
    expect(readdirSync(modelIdDir)).toEqual(["rev1"]);
  });

  // Review round 1 (F4): the brief's explicit defect class — "if no test pins the revision, that
  // is a finding." okFetchFn (above) matches every URL by SUFFIX only (u.endsWith("a.txt")), so it
  // would happily serve a request for .../resolve/main/a.txt just as well as
  // .../resolve/rev1/a.txt — no prior test ever inspected the middle of the URL. Confirmed: with
  // downloadAndVerifyInto's template literal changed from `resolve/${revision}/` to a hardcoded
  // `resolve/main/`, every OTHER test in this file still passed; only this one goes red.
  it("every fetch URL names the pinned REVISION, never a moving branch like 'main'", async () => {
    const urls: string[] = [];
    const fetchFn = vi.fn(async (url: string | URL) => {
      const u = String(url);
      urls.push(u);
      const content = u.endsWith("a.txt") ? A_CONTENT : u.endsWith("b.txt") ? B_CONTENT : undefined;
      if (content === undefined) return new Response(null, { status: 404 });
      return new Response(content, { status: 200 });
    }) as unknown as typeof fetch;

    await fetchAndVerifyModel(root, { ...SPEC, fetchFn });

    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      expect(u).toContain(`/resolve/${SPEC.revision}/`);
      expect(u).not.toContain("/resolve/main/");
    }
  });

  it("retries exactly once — attempt 1 fails on its first file (aborting that attempt), attempt 2 succeeds", async () => {
    let call = 0;
    const fetchFn = vi.fn(async (url: string | URL) => {
      call++;
      // Fail ONLY the very first request (attempt 1's first file, "a.txt") — the download loop
      // aborts an attempt on its first failing file, so attempt 1 never even reaches "sub/b.txt".
      if (call === 1) return new Response(null, { status: 500, statusText: "boom" });
      const u = String(url);
      const content = u.endsWith("a.txt") ? A_CONTENT : B_CONTENT;
      return new Response(content, { status: 200 });
    }) as unknown as typeof fetch;

    const finalDir = await fetchAndVerifyModel(root, { ...SPEC, fetchFn });
    expect(existsSync(join(finalDir, "a.txt"))).toBe(true);
    expect(existsSync(join(finalDir, "sub", "b.txt"))).toBe(true);
    expect(call).toBe(3); // attempt 1: a.txt (fails) | attempt 2: a.txt, sub/b.txt (both succeed)
  });

  it("throws a clear error naming 'bun run fetch-model' as the offline alternative when both attempts fail", async () => {
    const fetchFn = vi.fn(
      async () => new Response(null, { status: 500 }),
    ) as unknown as typeof fetch;
    await expect(fetchAndVerifyModel(root, { ...SPEC, fetchFn })).rejects.toThrow(
      /bun run fetch-model/,
    );
  });

  it("never leaves a partial or staging directory at the final path when every attempt fails", async () => {
    const fetchFn = vi.fn(
      async () => new Response(null, { status: 500 }),
    ) as unknown as typeof fetch;
    await expect(fetchAndVerifyModel(root, { ...SPEC, fetchFn })).rejects.toThrow();
    const finalDir = modelDirFor(root, SPEC);
    expect(existsSync(finalDir)).toBe(false);
    const modelIdDir = join(root, "acme", "tiny-model");
    // Nothing (not even a `.download-*` staging leftover) survives a total failure.
    expect(existsSync(modelIdDir) ? readdirSync(modelIdDir) : []).toEqual([]);
  });
});

// Review round 1 ("Also"/F11): the platform check must run BEFORE any download attempt, so an
// auto-selected deployment on an unsupported platform never spends the network round-trip only to
// fail later at model-load time. Uses `platformOverride` (real callers never set it — see the
// field's own doc comment) so this is assertable without the CI runner actually being darwin-x64
// or musl.
describe("platform check runs BEFORE the download (THE-944 review round 1)", () => {
  it("darwin-x64: refuses without ever calling fetchFn", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("must not be called — the platform check must refuse first");
    }) as unknown as typeof fetch;
    await expect(
      fetchAndVerifyModel(root, {
        ...SPEC,
        fetchFn,
        platformOverride: { platform: "darwin", arch: "x64" },
      }),
    ).rejects.toThrow(/darwin-x64/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("musl linux: refuses without ever calling fetchFn", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("must not be called — the platform check must refuse first");
    }) as unknown as typeof fetch;
    await expect(
      fetchAndVerifyModel(root, {
        ...SPEC,
        fetchFn,
        platformOverride: { platform: "linux", arch: "x64", isMuslRuntime: () => true },
      }),
    ).rejects.toThrow(/musl/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("an ALREADY-VERIFIED cache is still served on an unsupported platform (no download needed, so nothing to refuse)", async () => {
    const finalDir = modelDirFor(root, SPEC);
    await mkdir(join(finalDir, "sub"), { recursive: true });
    await writeFile(join(finalDir, "a.txt"), A_CONTENT);
    await writeFile(join(finalDir, "sub", "b.txt"), B_CONTENT);
    const fetchFn = vi.fn(async () => {
      throw new Error("must not be called — nothing to download");
    }) as unknown as typeof fetch;
    const resolved = await fetchAndVerifyModel(root, {
      ...SPEC,
      fetchFn,
      platformOverride: { platform: "darwin", arch: "x64" },
    });
    expect(resolved).toBe(finalDir);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("linux glibc x64: supported — unsupportedPlatformReason returns undefined", () => {
    expect(
      unsupportedPlatformReason({ platform: "linux", arch: "x64", isMuslRuntime: () => false }),
    ).toBeUndefined();
  });
});

// THE-944 review round 2 (G1): a cross-process lock around the fetch-and-publish sequence. Two
// concurrent fetchers on the SAME cold cache no longer both download — one wins the exclusive
// mkdir-based lock, the other waits (polling) and then finds the winner's freshly-published,
// verified directory WITHOUT ever acquiring the lock itself. Exercised via the REAL functions in
// ONE process (Promise.all): `mkdir` is a real, atomic filesystem syscall regardless of whether
// the two callers are two processes or two concurrent async calls in one process, so this
// genuinely proves the locking primitive, not merely in-process JS concurrency.
describe("cross-process lock (THE-944 review round 2, G1)", () => {
  it("two concurrent fetchers on a cold cache: exactly one downloads each file, the other observes the published dir", async () => {
    const downloadUrls: string[] = [];
    const fetchFn = vi.fn(async (url: string | URL) => {
      const u = String(url);
      downloadUrls.push(u);
      // Widen the race window so both fetchers are genuinely in flight together — without this,
      // a fast synchronous-ish stub could let the first call finish before the second even starts,
      // which would prove nothing about the LOCK (the second would just see an already-verified
      // cache from its own first check, never contending for anything).
      await new Promise((resolve) => setTimeout(resolve, 30));
      const content = u.endsWith("a.txt") ? A_CONTENT : u.endsWith("b.txt") ? B_CONTENT : undefined;
      if (content === undefined) return new Response(null, { status: 404 });
      return new Response(content, { status: 200 });
    }) as unknown as typeof fetch;

    const [dirA, dirB] = await Promise.all([
      fetchAndVerifyModel(root, { ...SPEC, fetchFn, lockPollMs: 5 }),
      fetchAndVerifyModel(root, { ...SPEC, fetchFn, lockPollMs: 5 }),
    ]);

    expect(dirA).toBe(modelDirFor(root, SPEC));
    expect(dirB).toBe(dirA);
    // The whole point: only ONE fetcher actually downloaded each pinned file — the loser waited
    // and reused the winner's work instead of racing it.
    expect(downloadUrls.filter((u) => u.endsWith("a.txt"))).toHaveLength(1);
    expect(downloadUrls.filter((u) => u.endsWith("b.txt"))).toHaveLength(1);
    const postCheck = await verifyModelDir(dirA, SPEC);
    expect(postCheck.every((r) => r.ok)).toBe(true);
    // No lock or staging directory survives a clean run.
    expect(existsSync(`${dirA}.lock`)).toBe(false);
  });

  it("a stale lock (owner crashed mid-download) is taken over rather than waited on forever", async () => {
    const finalDir = modelDirFor(root, SPEC);
    const lockDir = `${finalDir}.lock`;
    await mkdir(lockDir, { recursive: true });
    // A lock "started" 100 seconds ago, paired with a lockStaleMs of 10ms below — unambiguously
    // stale on the very first check, so this test does not need to wait out a real staleness
    // window to prove the takeover.
    await writeFile(
      join(lockDir, "owner.json"),
      JSON.stringify({ pid: 999999, startedAt: Date.now() - 100_000 }),
    );
    const fetchFn = okFetchFn();
    const resolved = await fetchAndVerifyModel(root, {
      ...SPEC,
      fetchFn,
      lockStaleMs: 10,
      lockPollMs: 5,
    });
    expect(resolved).toBe(finalDir);
    const postCheck = await verifyModelDir(resolved, SPEC);
    expect(postCheck.every((r) => r.ok)).toBe(true);
    expect(existsSync(lockDir)).toBe(false); // the taken-over lock was cleaned up, not left behind
  });

  it("a FRESH lock (not stale) is waited on, not taken over", async () => {
    const finalDir = modelDirFor(root, SPEC);
    const lockDir = `${finalDir}.lock`;
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      join(lockDir, "owner.json"),
      JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
    );
    const fetchFn = vi.fn(okFetchFn()) as unknown as typeof fetch;
    // A short-lived promise race: fetchAndVerifyModel should still be pending after a brief delay
    // (blocked polling on the fresh, held lock), not have resolved or even attempted a download.
    let settled = false;
    const p = fetchAndVerifyModel(root, {
      ...SPEC,
      fetchFn,
      lockStaleMs: 60_000,
      lockPollMs: 5,
    }).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(settled).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
    // Release the held lock so the pending call can proceed and this test resolves cleanly
    // instead of leaking a dangling promise into the next test.
    await releaseLockForTest(lockDir);
    const resolved = await p;
    expect(resolved).toBe(finalDir);
    expect(fetchFn).toHaveBeenCalled();
  });

  // THE-944 review round 3 (G1): the reviewer's own repro — a lock whose owner.json is MISSING or
  // UNPARSEABLE stayed "STILL-BLOCKED-after-3s" even with lockStaleMs: 10, because readLockOwner
  // returning undefined for either case made `owner && ...` short-circuit false and the (then
  // deadline-less) loop just kept sleeping forever. lockAgeMs's directory-mtime fallback closes both.
  it("an orphaned lock with NO owner.json (crash before the write ever landed) is taken over via the directory's own mtime", async () => {
    const finalDir = modelDirFor(root, SPEC);
    const lockDir = `${finalDir}.lock`;
    await mkdir(lockDir, { recursive: true });
    // No owner.json at all — simulates a crash between mkdir(lockDir) and the atomic write of
    // owner.json ever landing. Backdate the DIRECTORY's own mtime (what mkdir set to "now") so the
    // fallback has something unambiguously stale to observe, matching the reviewer's own
    // measurement setup (a lock "started" long before a tiny lockStaleMs).
    const old = new Date(Date.now() - 100_000);
    await utimes(lockDir, old, old);
    const fetchFn = okFetchFn();
    const resolved = await fetchAndVerifyModel(root, {
      ...SPEC,
      fetchFn,
      lockStaleMs: 10,
      lockPollMs: 5,
    });
    expect(resolved).toBe(finalDir);
    const postCheck = await verifyModelDir(resolved, SPEC);
    expect(postCheck.every((r) => r.ok)).toBe(true);
    expect(existsSync(lockDir)).toBe(false); // taken over and cleaned up, not left behind
  });

  it("a truncated, unparseable owner.json is taken over via the directory's own mtime", async () => {
    const finalDir = modelDirFor(root, SPEC);
    const lockDir = `${finalDir}.lock`;
    await mkdir(lockDir, { recursive: true });
    // A non-atomic write interrupted mid-flight — this is exactly what round 2's plain writeFile
    // (fixed in round 3 to temp-then-rename) could leave behind on a crash.
    await writeFile(join(lockDir, "owner.json"), '{"pid": 123, "starte');
    const old = new Date(Date.now() - 100_000);
    await utimes(lockDir, old, old); // set AFTER the write, which itself bumps the dir's mtime
    const fetchFn = okFetchFn();
    const resolved = await fetchAndVerifyModel(root, {
      ...SPEC,
      fetchFn,
      lockStaleMs: 10,
      lockPollMs: 5,
    });
    expect(resolved).toBe(finalDir);
    const postCheck = await verifyModelDir(resolved, SPEC);
    expect(postCheck.every((r) => r.ok)).toBe(true);
    expect(existsSync(lockDir)).toBe(false);
  });

  // THE-944 review round 3 (G1): the explicit backstop UNDER the stale-takeover check — a lock
  // whose age never crosses lockStaleMs (here, its owner.json is kept artificially "fresh" on an
  // interval faster than the poll) must still not be waited on forever. The overall deadline
  // (lockStaleMs * the exported multiplier) throws a clear, actionable error naming the lock path.
  it("gives up at the overall wait deadline when the lock never becomes stale, naming the lock path", async () => {
    const finalDir = modelDirFor(root, SPEC);
    const lockDir = `${finalDir}.lock`;
    await mkdir(lockDir, { recursive: true });
    // Atomic temp-then-rename — the SAME technique production's writeLockOwnerAtomic uses. A raw
    // in-place writeFile here would race with acquireLockOrObserveVerified's own concurrent reads:
    // a reader catching a torn write mid-flight sees unparseable JSON, falls through to lockAgeMs's
    // mtime fallback, and reads the LOCK DIRECTORY's ORIGINAL (long-past) mtime — triggering an
    // unintended EARLY stale-takeover that races this test's own deadline it's trying to reach.
    // Confirmed by observing it: an earlier, non-atomic version of this refresh flaked exactly that
    // way (the call returned successfully — via a premature takeover — instead of ever reaching the
    // deadline).
    const touch = async () => {
      const finalPath = join(lockDir, "owner.json");
      const tmpPath = join(lockDir, `owner.json.tmp-test-${Date.now()}-${Math.random()}`);
      await writeFile(tmpPath, JSON.stringify({ pid: 123, startedAt: Date.now() }));
      await rename(tmpPath, finalPath).catch(() => undefined);
    };
    await touch();
    const refresh = setInterval(() => {
      void touch();
    }, 5);
    try {
      let message = "";
      try {
        await fetchAndVerifyModel(root, {
          ...SPEC,
          fetchFn: okFetchFn(),
          lockStaleMs: 20,
          lockPollMs: 5,
        });
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      expect(message).toMatch(/gave up waiting for the model-fetch lock/);
      expect(message).toContain(lockDir);
    } finally {
      clearInterval(refresh);
      await rm(lockDir, { recursive: true, force: true });
    }
  });
});

/** Test-only: releases a lock this test created directly (bypassing the module's own internal
 *  `releaseLock`, which is not exported — this mirrors exactly what a crashed/finished OTHER
 *  process releasing its own lock looks like from the waiter's side). */
async function releaseLockForTest(lockDir: string): Promise<void> {
  await rm(lockDir, { recursive: true, force: true });
}

// THE-944 review round 2 (G2): verifyModelDir now lstats every path (never follows a symlink) and
// rejects any entry present under the model directory that is not one of the pinned files.
describe("symlink and extraneous-entry hardening (THE-944 review round 2, G2)", () => {
  it("a symlinked model file is refused — even when the symlink's TARGET has byte-identical, correctly-hashing content", async () => {
    const dir = modelDirFor(root, SPEC);
    await mkdir(join(dir, "sub"), { recursive: true });
    const realTarget = join(root, "real-a.txt");
    await writeFile(realTarget, A_CONTENT); // genuinely correct bytes, just not AT the pinned path
    await symlink(realTarget, join(dir, "a.txt"));
    await writeFile(join(dir, "sub", "b.txt"), B_CONTENT);

    const results = await verifyModelDir(dir, SPEC);
    const aResult = results.find((r) => r.file.path === "a.txt");
    expect(aResult?.ok).toBe(false);
    expect(aResult?.reason).toMatch(/symlink/);
    // The pre-round-2 implementation (existsSync/statSync, which FOLLOW symlinks) would have
    // reported this "ok" — the mutation evidence for this exact regression lives in the fix-round
    // report.
  });

  it("a symlinked DIRECTORY standing in for a real one (e.g. 'sub') fails the OVERALL verdict, even though the pinned lstat check alone cannot see it", async () => {
    // lstat only refuses to follow the FINAL path component, not an intermediate one — POSIX
    // semantics, not a bug here: lstat("dir/sub/b.txt") legitimately reaches the real file THROUGH
    // the symlinked "sub" and reports it as a genuine regular file with correct bytes, so the
    // per-pinned-file check for "sub/b.txt" alone cannot detect this case. What DOES catch it is
    // listRelativeEntries (used for the extraneous-entry check below): it classifies "sub" itself
    // via Dirent.isSymbolicLink() and never descends into it, so "sub" shows up as an entry that is
    // NOT one of the pinned file paths ("a.txt", "sub/b.txt") — refused for THAT reason, and the
    // overall verdict (what every real caller actually checks: `results.every(r => r.ok)`) is
    // false regardless of what the individual "sub/b.txt" sub-result says.
    const dir = modelDirFor(root, SPEC);
    const realSub = join(root, "real-sub");
    await mkdir(realSub, { recursive: true });
    await writeFile(join(realSub, "b.txt"), B_CONTENT);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.txt"), A_CONTENT);
    await symlink(realSub, join(dir, "sub"));

    const results = await verifyModelDir(dir, SPEC);
    expect(results.every((r) => r.ok)).toBe(false); // the overall verdict every real caller checks
    const unexpected = results.filter((r) => !SPEC.pinnedFiles.some((f) => f.path === r.file.path));
    expect(unexpected.some((r) => r.file.path === "sub" && !r.ok)).toBe(true);
  });

  it("an extra, unexpected file planted in the cache is refused, even though every pinned file is itself correct", async () => {
    const dir = modelDirFor(root, SPEC);
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "a.txt"), A_CONTENT);
    await writeFile(join(dir, "sub", "b.txt"), B_CONTENT);
    await writeFile(join(dir, "sub", "evil.txt"), "planted");

    const results = await verifyModelDir(dir, SPEC);
    expect(results.find((r) => r.file.path === "a.txt")?.ok).toBe(true);
    expect(results.find((r) => r.file.path === "sub/b.txt")?.ok).toBe(true);
    const evil = results.find((r) => r.file.path === "sub/evil.txt");
    expect(evil?.ok).toBe(false);
    expect(evil?.reason).toMatch(/unexpected entry/);
    expect(evil?.reason).toContain("sub/evil.txt");
    expect(evil?.reason).toMatch(/remove it/);
  });

  // THE-944 review round 3 (NB2): a stray OS housekeeping file (Finder's .DS_Store, Windows'
  // Thumbs.db/desktop.ini) must not fail an otherwise-correct cache — merely BROWSING an offline,
  // pre-staged cache directory in a file manager is enough to create one, and before this fix that
  // made the whole directory report unverified.
  it("ignores exactly the OS-junk allowlist (.DS_Store, Thumbs.db, desktop.ini) — the cache still verifies clean", async () => {
    const dir = modelDirFor(root, SPEC);
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "a.txt"), A_CONTENT);
    await writeFile(join(dir, "sub", "b.txt"), B_CONTENT);
    await writeFile(join(dir, ".DS_Store"), "finder metadata, not a pinned file");
    await writeFile(join(dir, "sub", "Thumbs.db"), "explorer thumbnail cache");
    await writeFile(join(dir, "desktop.ini"), "[.ShellClassInfo]");

    const results = await verifyModelDir(dir, SPEC);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results).toHaveLength(2); // only the two PINNED files are reported at all — junk is invisible
  });

  it("still refuses everything that is NOT on the OS-junk allowlist — the allowlist is not a general escape hatch", async () => {
    const dir = modelDirFor(root, SPEC);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.txt"), A_CONTENT);
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "sub", "b.txt"), B_CONTENT);
    // A name that merely LOOKS like OS junk (wrong case, or a near-miss) must still be refused —
    // proves the allowlist is exact, not a prefix/substring match.
    await writeFile(join(dir, ".ds_store"), "lowercase — not the real Finder name");
    await writeFile(join(dir, "thumbs.db.bak"), "not the real Windows name either");

    const results = await verifyModelDir(dir, SPEC);
    expect(results.every((r) => r.ok)).toBe(false);
    const bad = results.filter((r) => !r.ok).map((r) => r.file.path);
    expect(bad).toContain(".ds_store");
    expect(bad).toContain("thumbs.db.bak");
  });

  it("fetchAndVerifyModel's fast path is unaffected by OS junk — an offline pre-staged cache with a .DS_Store still short-circuits with zero network calls", async () => {
    const dir = modelDirFor(root, SPEC);
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "a.txt"), A_CONTENT);
    await writeFile(join(dir, "sub", "b.txt"), B_CONTENT);
    await writeFile(join(dir, ".DS_Store"), "finder metadata");
    const fetchFn = vi.fn(async () => {
      throw new Error("must not be called — the cache (junk aside) is already verified");
    }) as unknown as typeof fetch;
    const resolved = await fetchAndVerifyModel(root, { ...SPEC, fetchFn });
    expect(resolved).toBe(dir);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("assertVerified resolves on a clean directory and throws on a corrupted one, naming the file", async () => {
    const dir = modelDirFor(root, SPEC);
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "a.txt"), A_CONTENT);
    await writeFile(join(dir, "sub", "b.txt"), B_CONTENT);
    await expect(assertVerified(dir, SPEC)).resolves.toBeUndefined();

    await writeFile(join(dir, "a.txt"), "SWAPPED!!!"); // corrupt AFTER the successful check above
    await expect(assertVerified(dir, SPEC)).rejects.toThrow(/a\.txt/);
  });

  // THE-944 review round 2 (G2) test requirement: "a byte swapped between verify and load is
  // refused." fetchAndVerifyModel verifies and publishes; the swap below happens strictly AFTER
  // that returns — simulating exactly the TOCTOU window between fetchAndVerifyModel's own
  // verification and the from_pretrained calls in index.ts's loadSession. assertVerified is the
  // function loadSession calls, as a step DISTINCT from fetchAndVerifyModel's own check, to close
  // that window — this proves it actually catches a swap that happens in it.
  it("a byte swapped strictly AFTER fetchAndVerifyModel published is caught by assertVerified before load", async () => {
    const fetchFn = okFetchFn();
    const finalDir = await fetchAndVerifyModel(root, { ...SPEC, fetchFn });
    await expect(assertVerified(finalDir, SPEC)).resolves.toBeUndefined(); // clean right after fetch

    await writeFile(join(finalDir, "sub", "b.txt"), "world-SWAP"); // same length, wrong bytes
    await expect(assertVerified(finalDir, SPEC)).rejects.toThrow(/sub\/b\.txt/);
  });
});

// THE-944 review round 2 (G4): pin the FINAL host after redirects are followed, to the
// huggingface.co/hf.co suffix allowlist — see downloadFile's own doc comment for the live
// observation (curl -sI -L against this package's real pinned URL, 2026-09-03) and the two cited
// discuss.huggingface.co threads documenting why a suffix, not a fixed hostname list.
describe("redirect host pinning (THE-944 review round 2 G4, pre-connect check added round 3 NB4)", () => {
  function redirectResponse(location: string, status = 302): Response {
    return new Response(null, { status, headers: { location } });
  }

  // THE-944 review round 3 (NB4): the explicit ask — refused with NO second fetch call to the
  // off-allowlist host. Every call `fetchFn` sees is asserted, proving the connection to the bad
  // host is never attempted, not merely that its bytes are discarded after the fact.
  it("refuses a redirect that lands off the huggingface.co/hf.co allowlist entirely, calling fetchFn ONLY for the original (never the bad) host", async () => {
    const calls: string[] = [];
    const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push(String(url));
      expect(init?.redirect).toBe("manual");
      return redirectResponse("https://evil.example.com/payload");
    }) as unknown as typeof fetch;
    await expect(fetchAndVerifyModel(root, { ...SPEC, fetchFn })).rejects.toThrow(
      /evil\.example\.com|unexpected host/,
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((u) => !u.includes("evil.example.com"))).toBe(true);
    expect(calls.every((u) => u.includes("huggingface.co"))).toBe(true);
  });

  it("refuses a redirect to a lookalike host (huggingface.co.evil.example.com — suffix match must anchor at a dot)", async () => {
    const calls: string[] = [];
    const fetchFn = vi.fn(async (url: string | URL) => {
      calls.push(String(url));
      return redirectResponse("https://huggingface.co.evil.example.com/payload");
    }) as unknown as typeof fetch;
    await expect(fetchAndVerifyModel(root, { ...SPEC, fetchFn })).rejects.toThrow(
      /unexpected host/,
    );
    expect(calls.every((u) => !u.includes("huggingface.co.evil.example.com"))).toBe(true);
  });

  it("refuses a redirect response with no Location header at all", async () => {
    const fetchFn = vi.fn(
      async () => new Response(null, { status: 302 }),
    ) as unknown as typeof fetch;
    await expect(fetchAndVerifyModel(root, { ...SPEC, fetchFn })).rejects.toThrow(
      /no Location header/,
    );
  });

  it("refuses an absurd redirect loop after MAX_REDIRECT_HOPS rather than following indefinitely", async () => {
    let hop = 0;
    const fetchFn = vi.fn(async () => {
      hop++;
      return redirectResponse(`https://huggingface.co/loop-${hop}`);
    }) as unknown as typeof fetch;
    await expect(fetchAndVerifyModel(root, { ...SPEC, fetchFn })).rejects.toThrow(
      /too many redirects/,
    );
  });

  it("allows the REAL observed CDN redirect host (us.aws.cdn.hf.co) via a genuine 302 + Location, followed hop by hop", async () => {
    const fetchFn = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.startsWith("https://us.aws.cdn.hf.co/")) {
        const content = u.endsWith("a.txt") ? A_CONTENT : B_CONTENT;
        return new Response(content, { status: 200 });
      }
      const file = u.split("/").pop();
      return redirectResponse(`https://us.aws.cdn.hf.co/xet-bridge-us/${file}`);
    }) as unknown as typeof fetch;
    const resolved = await fetchAndVerifyModel(root, { ...SPEC, fetchFn });
    const postCheck = await verifyModelDir(resolved, SPEC);
    expect(postCheck.every((r) => r.ok)).toBe(true);
  });

  it("allows a same-host RELATIVE Location redirect (the small-file /api/resolve-cache/... shape observed live)", async () => {
    const fetchFn = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/resolve-cache/")) {
        const content = u.endsWith("a.txt") ? A_CONTENT : B_CONTENT;
        return new Response(content, { status: 200 });
      }
      const file = u.split("/").pop();
      // A relative Location, matching HF's own small-file redirect shape — resolves against the
      // CURRENT url's own host, so this must stay allowed without ever becoming an absolute URL.
      return redirectResponse(`/api/resolve-cache/${file}`);
    }) as unknown as typeof fetch;
    const resolved = await fetchAndVerifyModel(root, { ...SPEC, fetchFn });
    const postCheck = await verifyModelDir(resolved, SPEC);
    expect(postCheck.every((r) => r.ok)).toBe(true);
  });

  it("allows a direct 200 with no redirect at all — the common case every OTHER test in this file relies on", async () => {
    const fetchFn = okFetchFn();
    const resolved = await fetchAndVerifyModel(root, { ...SPEC, fetchFn });
    const postCheck = await verifyModelDir(resolved, SPEC);
    expect(postCheck.every((r) => r.ok)).toBe(true);
  });
});
