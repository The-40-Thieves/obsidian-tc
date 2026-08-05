// THE-649: the filesystem watch that docs/SYNC.md has always described and that did not exist.
//
// Two layers, deliberately separated. `shouldWatchPath` is pure policy and is tested exhaustively
// without touching a disk — that is where the security-relevant rules live. `startVaultWatch` is
// tested against a REAL filesystem, because the whole feature is an assertion about what the OS
// reports; a mocked fs.watch would only prove the test's own model of inotify.

import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  normalizeWatchPath,
  registerVaultWatch,
  resolveWatchedPath,
  shouldWatchPath,
  startVaultWatch,
} from "../src/vault/watcher";
import { rmTemp } from "./tmp";

/**
 * Wait for the watcher to actually be armed before writing.
 *
 * Not padding: Linux inotify is live by the time watch() returns, but macOS backs a recursive watch
 * with FSEvents, which arms asynchronously — a write issued immediately after watch() returns can
 * land before the stream is listening and is then never reported. That is a real property of the
 * platform, not flakiness, and it is why the multi-vault case failed only on macos-latest.
 */
const arm = (): Promise<void> => new Promise((r) => setTimeout(r, 400));

function makeVault(): string {
  return mkdtempSync(join(tmpdir(), "tc-watch-"));
}

// Creating a symlink needs a privilege Windows does not grant by default, so the symlink case is
// capability-probed rather than platform-sniffed — the same probe acl-symlink-canonical.test.ts
// uses. The HARD-link case below is deliberately NOT guarded: acl-hardlink.test.ts already creates
// hard links unguarded on every runner, so gating that one would silently drop the coverage that
// matters most on the platform where it still works.
let symlinkOk = true;
try {
  const probe = mkdtempSync(join(tmpdir(), "tc-sl-probe-"));
  symlinkSync(join(probe, "t"), join(probe, "l"), "dir");
  rmTemp(probe);
} catch {
  symlinkOk = false; // Windows without the privilege to create symlinks
}

/** Collects sink calls, and resolves once `n` of them have arrived (or the deadline passes). */
function recorder() {
  const upserts: Array<[string, string, string]> = [];
  const deletes: Array<[string, string]> = [];
  return {
    upserts,
    deletes,
    onUpsert: (v: string, p: string, c: string) => upserts.push([v, p, c]),
    onDelete: (v: string, p: string) => deletes.push([v, p]),
    /** Drop everything seen so far, so a test can assert about ONE transition in isolation. */
    reset(): void {
      upserts.length = 0;
      deletes.length = 0;
    },
    /**
     * Wait until `pred` holds, then keep waiting a little longer.
     *
     * The trailing quiet period is what lets a test assert "exactly one" — it gives a second,
     * unwanted call time to arrive and be caught rather than racing the assertion. The ceiling is
     * generous because FSEvents applies its own coalescing latency on top of our debounce and CI
     * runners are slower than a dev box; a long ceiling costs patience only when something is
     * already wrong.
     */
    async until(pred: () => boolean, timeoutMs = 10_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (!pred() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      await new Promise((r) => setTimeout(r, 250));
    },
    /** Wait for `n` sink calls of ANY kind. Prefer `until` when the KIND matters — counting any
     *  event lets a stray duplicate satisfy the wait before the event under test has arrived. */
    async settle(n = 1, timeoutMs = 10_000): Promise<void> {
      await this.until(() => upserts.length + deletes.length >= n, timeoutMs);
    },
  };
}

/**
 * Collapse IDENTICAL deliveries, and nothing else (THE-660).
 *
 * macOS can deliver the same change twice — its recursive stream replays recent history when it
 * arms, and coalescing is best-effort — so "this fired exactly once" is a claim about FSEvents, not
 * about our code. It flaked `build-test (macos-latest)` on a PR that touched only a workflow file:
 * one write, two upserts, `expected [ [ 'v1', …(2) ], [ 'v1', …(2) ] ] to deeply equal [ Array(1) ]`.
 *
 * Deduping by value keeps every claim that IS ours. A duplicate is harmless in production because
 * upserts are idempotent — the index converges on the same state either way — but an upsert for an
 * unexpected path, vault, or content is a distinct tuple and still fails. That is the difference
 * between tolerating the platform and weakening the test: the `.md`-only filter below still catches
 * a stray `.txt`, and the multi-vault case still catches a note attributed to the wrong vault.
 */
function uniqueUpserts(
  rows: ReadonlyArray<[string, string, string]>,
): Array<[string, string, string]> {
  const seen = new Map<string, [string, string, string]>();
  for (const row of rows) seen.set(JSON.stringify(row), row);
  return [...seen.values()];
}

describe("shouldWatchPath — eligibility policy (mirrors walkVault)", () => {
  it("accepts markdown at the root and nested", () => {
    expect(shouldWatchPath("a.md")).toBe(true);
    expect(shouldWatchPath("Projects/Deep/nested note.md")).toBe(true);
  });

  it("matches the .md extension case-INSENSITIVELY, as walkVault does", () => {
    // walkVault lowercases the name before comparing extensions, so `NOTE.MD` IS a note there. A
    // case-sensitive check here would leave such a file indexed by index_vault but invisible to the
    // watch — the two paths would disagree permanently, and only on case-insensitive filesystems
    // would anyone notice.
    expect(shouldWatchPath("NOTE.MD")).toBe(true);
    expect(shouldWatchPath("Note.Md")).toBe(true);
  });

  it("rejects non-markdown", () => {
    for (const p of ["a.txt", "a.markdown", "a.md.bak", "image.png", "noext"]) {
      expect(shouldWatchPath(p)).toBe(false);
    }
  });

  it("rejects a dot-segment at ANY depth — the G2.4 default-deny set", () => {
    // Non-empty and explicit: these are the directories the watch must never surface. `.obsidian-tc`
    // is where the server writes its own session traces, so admitting it would let the watch see its
    // own bookkeeping.
    for (const p of [
      ".obsidian/plugins/x.md",
      ".obsidian-tc/traces/sess.md",
      ".git/COMMIT_EDITMSG.md",
      ".trash/deleted.md",
      "Projects/.hidden/secret.md",
      "Projects/.secret.md",
    ]) {
      expect(shouldWatchPath(p)).toBe(false);
    }
  });

  it("rejects a traversal segment, so join(root, rel) cannot escape the vault", () => {
    // flush() does `join(root, rel)` with no separate containment check, which is only sound because
    // nothing with a `..` segment gets this far. That holds today for a second reason — the OS
    // reports watch paths relative to the root and never emits `..` — but relying on the platform
    // for a containment property is how THE-610 shipped a `join`-based delete path that resolved to
    // /tmp/evil. Asserting it here makes the guarantee local to this function.
    for (const p of ["../evil.md", "a/../../evil.md", "../../etc/passwd.md"]) {
      expect(shouldWatchPath(p)).toBe(false);
    }
  });

  it("does not confuse a dot INSIDE a segment with a leading dot", () => {
    expect(shouldWatchPath("my.notes/file.md")).toBe(true);
    expect(shouldWatchPath("2026.07.27 daily.md")).toBe(true);
  });
});

describe("normalizeWatchPath", () => {
  it("forward-slashes a Windows-style separator so the dot-segment rule can see segments", () => {
    // Without this, `.obsidian\plugins\x.md` is ONE segment that does not start with a dot... it
    // does here, but `Projects\.hidden\x.md` would not, and would be admitted. Normalizing first is
    // what makes the split-on-"/" rule sound on both platforms.
    expect(normalizeWatchPath("Projects\\.hidden\\x.md")).toBe("Projects/.hidden/x.md");
    expect(shouldWatchPath(normalizeWatchPath("Projects\\.hidden\\x.md"))).toBe(false);
  });
});

// Real filesystem, NO watcher. Every security-relevant guarantee of this module lives in
// resolveWatchedPath and none of it involves fs.watch, so it is tested as the pure function it is —
// deterministic on all three platforms. Asserting these THROUGH the OS watcher is what made a
// correct symlink guard fail on macOS for pure timing reasons: FSEvents arms more slowly than
// inotify, and a security assertion should never be able to fail for that reason.
describe("resolveWatchedPath — classification and the two alias guards", () => {
  it("reads an ordinary single-linked note", () => {
    const root = makeVault();
    writeFileSync(join(root, "a.md"), "hello", "utf8");
    expect(resolveWatchedPath(root, "a.md")).toEqual({ kind: "upsert", content: "hello" });
  });

  it("reports a missing path as a delete", () => {
    expect(resolveWatchedPath(makeVault(), "nope.md")).toEqual({ kind: "delete" });
  });

  it("reports a directory that took a note's name as a delete", () => {
    const root = makeVault();
    mkdirSync(join(root, "folder.md"));
    expect(resolveWatchedPath(root, "folder.md")).toEqual({ kind: "delete" });
  });

  it.skipIf(!symlinkOk)("NEVER follows a symlink out of the vault", () => {
    // walkVault classifies from readdir Dirents, whose isFile() is false for a symlink, so
    // index_vault silently skips them and never reads the target. Using stat (which follows) would
    // read the target through a symlink planted in the vault and index it via a path the full walk
    // cannot reach. readNote alone would NOT catch this — its open() follows the link and its fstat
    // then describes the target, which for an ordinary file passes every check.
    const root = makeVault();
    const outside = mkdtempSync(join(tmpdir(), "tc-outside-"));
    writeFileSync(join(outside, "secret.txt"), "SENSITIVE-OUTSIDE-VAULT", "utf8");
    symlinkSync(join(outside, "secret.txt"), join(root, "evil.md"));
    const r = resolveWatchedPath(root, "evil.md");
    expect(JSON.stringify(r)).not.toContain("SENSITIVE");
    expect(r).toEqual({ kind: "delete" });
  });

  it("NEVER reads a HARD LINK to a file outside the vault", () => {
    // The second alias, and the one lstat cannot see: a hard link IS a regular file (isFile() true,
    // nlink 2), so it reads as an ordinary note. It is a second name for an inode that may live
    // anywhere on the same filesystem, and realpath cannot dereference it — which is why notes-io's
    // assertRegularSingleLink fstats the OPEN fd and refuses nlink > 1.
    //
    // This bypass shipped in the first draft, which called readFileSync directly and reproduced only
    // walkVault's symlink test. Routing the read through readNote — the exact function indexVault
    // uses — is what closed it.
    //
    // Deliberately NOT platform-guarded (acl-hardlink.test.ts creates hard links unguarded on every
    // runner). It also covers BOTH implementations across the matrix: locally nativeVaultIo is true
    // so this exercises the Rust guard at packages/native/src/lib.rs:252, while CI's build-test
    // builds no native module and so exercises the JS fallback in notes-io.ts.
    const root = makeVault();
    const outside = mkdtempSync(join(tmpdir(), "tc-outside-"));
    const secret = join(outside, "secret.md");
    writeFileSync(secret, "TOP-SECRET-OUTSIDE-VAULT", "utf8");
    linkSync(secret, join(root, "innocent.md"));
    const r = resolveWatchedPath(root, "innocent.md");
    expect(JSON.stringify(r)).not.toContain("TOP-SECRET");
    // `refused`, not `delete`: the caller evicts either way, but a refusal is surfaced rather than
    // passing for an ordinary delete.
    expect(r.kind).toBe("refused");
  });

  it("still reads a note with a SECOND name inside the same vault — refusal is not blanket", () => {
    // Pairs with the two alias tests: without it, an implementation that refused EVERY file would
    // pass both. It also pins the deliberate strictness — an in-vault hard link is refused too,
    // because nlink cannot tell you WHERE the other name is.
    const root = makeVault();
    writeFileSync(join(root, "one.md"), "body", "utf8");
    expect(resolveWatchedPath(root, "one.md")).toEqual({ kind: "upsert", content: "body" });
    linkSync(join(root, "one.md"), join(root, "two.md"));
    expect(resolveWatchedPath(root, "two.md").kind).toBe("refused");
  });
});

describe("the watch must not hold the event loop open", () => {
  // A behavioural test cannot see this: vitest's own process stays alive regardless, so a watcher
  // that pins the loop looks identical to one that does not. The failure mode is a HANG, not an
  // assertion — it cost a 20-minute install-smoke timeout, because that lane runs
  // `node dist/cli.js < /dev/null` and expects the server to reach stdio-ready and exit.
  //
  // So this is a source scan, with a non-empty floor so a moved file cannot make it pass vacuously.
  const RAW = readFileSync(new URL("../src/vault/watcher.ts", import.meta.url), "utf8");
  // Comments stripped before scanning. The first run of this gate failed on its OWN documentation —
  // the comment explaining why `w.unref()` is wrong contains the literal `w.unref()`. A source scan
  // that reads prose is measuring the wrong thing.
  const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("reads its own source, comments stripped (floor — else every assertion below is vacuous)", () => {
    expect(RAW.length).toBeGreaterThan(2000);
    // The strip must not have eaten the code: both of these live in the watch() call itself.
    expect(SRC).toContain("recursive: true");
    expect(SRC).toContain("startVaultWatch");
    // And it must actually have removed prose, or the "no w.unref" assertion proves nothing.
    expect(SRC.length).toBeLessThan(RAW.length * 0.75);
  });

  it("passes persistent:false to watch(), which unref() cannot substitute for", () => {
    // Measured (Linux 6.17, node 26): watch(dir, {recursive:true}) + w.unref() NEVER lets the
    // process exit, even though unref is a real function on the returned FSWatcher — Node backs a
    // recursive watch with a tree of internal per-directory watchers and unref'ing the parent does
    // not propagate. {recursive:true, persistent:false} exits immediately.
    // THE-657: the first argument is `watchRoot` (realpathSync.native of t.root), not t.root.
    // `persistent: false` is what this gate exists to pin — a hang fails no assertion, so nothing
    // else would catch its removal — and it is still pinned.
    expect(SRC).toMatch(
      /watch\(\s*watchRoot,\s*\{\s*recursive:\s*true,\s*persistent:\s*false\s*\}/,
    );
    // And the realpath itself, for the same reason: swapping it back to t.root would reintroduce
    // the libuv abort on any 8.3 short path, which no runtime assertion can catch either — the
    // process dies before one could run.
    expect(SRC).toMatch(/realpathSync\.native\(/);
  });

  it("does not rely on unref() for the watcher (only for the debounce timer)", () => {
    expect(SRC).not.toMatch(/\bw\.unref\b/);
    // The debounce timer's unref IS correct and must stay — a pending flush should never be the
    // reason a process lingers.
    expect(SRC).toMatch(/timer\.unref/);
  });
});

describe("registerVaultWatch — start/skip decision", () => {
  // `platform` is injectable precisely so this runs on EVERY leg rather than only the one where it
  // matters. A Windows-only guard tested only on Windows would be tested nowhere useful.
  const noHooks = { onUpsert: () => {}, onDelete: () => {} };

  it("starts a watch on EVERY platform, and never prints the old Windows skip notice", () => {
    // THE-657 inverted this test rather than deleting it, and dropped the injected platform with
    // the branch it was there to assert. That makes it STRONGER, not weaker: it no longer
    // SIMULATES win32 from Linux, it runs for real on whatever platform executes it — and
    // `build-test (windows-latest)` is a required check, so the Windows case is genuinely covered
    // on every PR instead of being mocked.
    //
    // The gate is gone because the crash was an 8.3 short path reaching libuv, not recursive
    // watch: measured on windows-latest, the same harness died under os.tmpdir() and survived
    // twice under a realpath'd root. Asserting the ABSENCE of the old stderr line is what stops a
    // well-meaning revert quietly restoring the skip.
    const root = makeVault();
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => {
      writes.push(String(c));
      return true;
    });
    try {
      const stop = registerVaultWatch(
        [{ id: "v1", path: root }],
        { enabled: true, debounceMs: 50 },
        noHooks,
      );
      expect(writes.join("")).not.toContain("not started on Windows");
      expect(() => stop()).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  it("returns a no-op stop when disabled, without touching the filesystem", () => {
    const stop = registerVaultWatch(
      [{ id: "v1", path: join(tmpdir(), "tc-never-created-649") }],
      { enabled: false, debounceMs: 50 },
      noHooks,
    );
    // A missing root would have reported an error had a watch actually been attempted.
    expect(() => stop()).not.toThrow();
  });
});

// Skipped on Windows because the worker process does not survive it — see registerVaultWatch's note.
// Nothing security-relevant is lost: every alias guard and classification rule is asserted above via
// resolveWatchedPath, which runs on all four CI legs. What is skipped here is event DELIVERY, and
// registerVaultWatch does not start a watch on Windows anyway, so this matches what ships.
// THE-657: the win32 skip is GONE. These tests died on Windows because the fixture lives under
// os.tmpdir(), which resolves to an 8.3 short path (`C:\Users\RUNNER~1\...`); libuv
// prefix-compares event filenames against the watched directory and ABORTS the process when they
// disagree. startVaultWatch now watches `realpathSync.native(root)`, so the short form never
// reaches libuv. Measured: the same harness died on a tmpdir root and survived on a realpath'd one.
//
// Keeping them RUNNING on Windows is the point — build-test (windows-latest) is a required check,
// so if the realpath fix regresses, this block dies again and the leg goes red. Skipping would put
// the one platform that needed the fix back outside the only gate that can catch it.
describe("startVaultWatch — event delivery", () => {
  // These assert only that the OS reaches us and that coalescing/shutdown behave — the classification
  // rules are covered above without any timing dependency.
  it("reports a newly created note, including in a NESTED directory", async () => {
    const root = makeVault();
    mkdirSync(join(root, "Projects", "Deep"), { recursive: true });
    const r = recorder();
    const stop = startVaultWatch({
      targets: [{ vaultId: "v1", root }],
      debounceMs: 50,
      onUpsert: r.onUpsert,
      onDelete: r.onDelete,
    });
    try {
      await arm();
      writeFileSync(join(root, "Projects", "Deep", "n.md"), "deep", "utf8");
      await r.settle();
      expect(uniqueUpserts(r.upserts)).toEqual([["v1", "Projects/Deep/n.md", "deep"]]);
    } finally {
      stop();
    }
  });

  it("reports a deleted note as a delete, not an upsert", async () => {
    // Create the note AFTER the watch is armed, let its upsert land, then reset and delete — so
    // this asserts about the delete TRANSITION in isolation.
    //
    // The earlier shape (create the file first, arm, delete, assert no upserts) failed only on
    // macos-latest, with an upsert carrying the note's pre-deletion content. That is FSEvents
    // working as designed: a recursive stream replays recent history when it arms, so the file's
    // own creation — from before the watcher existed — was delivered afterwards. Harmless in
    // production (an upsert followed by a delete converges on the same index state), but it makes
    // "no upsert ever happened" an untestable claim on that platform.
    const root = makeVault();
    const r = recorder();
    const stop = startVaultWatch({
      targets: [{ vaultId: "v1", root }],
      debounceMs: 50,
      onUpsert: r.onUpsert,
      onDelete: r.onDelete,
    });
    try {
      await arm();
      writeFileSync(join(root, "gone.md"), "bye", "utf8");
      await r.settle();
      expect(uniqueUpserts(r.upserts)).toEqual([["v1", "gone.md", "bye"]]);
      r.reset();

      rmSync(join(root, "gone.md"));
      // until(deletes), not settle(1): a stray duplicate upsert would satisfy a plain count and let
      // the assertion run before the delete had arrived.
      await r.until(() => r.deletes.length >= 1);
      expect(r.deletes).toEqual([["v1", "gone.md"]]);
      expect(r.upserts).toEqual([]);
    } finally {
      stop();
    }
  });

  it("ignores non-markdown and dot-directory writes entirely", async () => {
    const root = makeVault();
    mkdirSync(join(root, ".obsidian-tc"), { recursive: true });
    const r = recorder();
    const stop = startVaultWatch({
      targets: [{ vaultId: "v1", root }],
      debounceMs: 50,
      onUpsert: r.onUpsert,
      onDelete: r.onDelete,
    });
    try {
      await arm();
      writeFileSync(join(root, "notes.txt"), "x", "utf8");
      writeFileSync(join(root, ".obsidian-tc", "trace.md"), "x", "utf8");
      // Then a real note, to prove the watch was alive the whole time rather than simply broken —
      // "nothing fired" is otherwise indistinguishable from a watcher that never started.
      writeFileSync(join(root, "real.md"), "real", "utf8");
      await r.settle();
      expect(uniqueUpserts(r.upserts)).toEqual([["v1", "real.md", "real"]]);
      expect(r.deletes).toEqual([]);
    } finally {
      stop();
    }
  });

  it("coalesces a burst of writes to one path into a single upsert with the FINAL content", async () => {
    const root = makeVault();
    const r = recorder();
    const stop = startVaultWatch({
      targets: [{ vaultId: "v1", root }],
      debounceMs: 200,
      onUpsert: r.onUpsert,
      onDelete: r.onDelete,
    });
    try {
      await arm();
      for (const c of ["v1", "v2", "v3", "v4"]) {
        writeFileSync(join(root, "busy.md"), c, "utf8");
      }
      await r.settle();
      expect(r.upserts).toHaveLength(1);
      // Read at flush time, so an editor's several save events cost one reindex of the end state.
      expect(r.upserts[0]?.[2]).toBe("v4");
    } finally {
      stop();
    }
  });

  it("keeps vaults separate and reports each under its own id", async () => {
    const a = makeVault();
    const b = makeVault();
    const r = recorder();
    const stop = startVaultWatch({
      targets: [
        { vaultId: "va", root: a },
        { vaultId: "vb", root: b },
      ],
      debounceMs: 50,
      onUpsert: r.onUpsert,
      onDelete: r.onDelete,
    });
    try {
      await arm();
      writeFileSync(join(a, "in-a.md"), "A", "utf8");
      writeFileSync(join(b, "in-b.md"), "B", "utf8");
      await r.settle(2);
      expect(uniqueUpserts(r.upserts).sort()).toEqual([
        ["va", "in-a.md", "A"],
        ["vb", "in-b.md", "B"],
      ]);
    } finally {
      stop();
    }
  });

  it("survives an unwatchable vault and keeps watching the others", async () => {
    // A missing root is the realistic shape (a vault on an unmounted volume); ENOSPC from the
    // inotify limit takes the same branch. Refusing to boot over one bad vault would be strictly
    // worse than the pre-THE-649 behaviour of not watching at all.
    //
    // This also pins the RUNTIME DIVERGENCE that the explicit statSync in startVaultWatch exists to
    // erase: Bun's watch() throws ENOENT for a missing root, Node's returns a live-looking watcher
    // that never fires and never errors. This test fails against a build that leans on the runtime,
    // and it failed exactly that way before the check was added.
    const good = makeVault();
    const errs: Array<[unknown, string]> = [];
    const r = recorder();
    const stop = startVaultWatch({
      targets: [
        { vaultId: "missing", root: join(tmpdir(), "tc-does-not-exist-649") },
        { vaultId: "good", root: good },
      ],
      debounceMs: 50,
      onUpsert: r.onUpsert,
      onDelete: r.onDelete,
      onError: (e, v) => errs.push([e, v]),
    });
    try {
      expect(errs.map((e) => e[1])).toEqual(["missing"]);
      await arm();
      writeFileSync(join(good, "still-works.md"), "ok", "utf8");
      await r.settle();
      expect(uniqueUpserts(r.upserts)).toEqual([["good", "still-works.md", "ok"]]);
    } finally {
      stop();
    }
  });

  it("stop() is idempotent and silences further events", async () => {
    const root = makeVault();
    const r = recorder();
    const stop = startVaultWatch({
      targets: [{ vaultId: "v1", root }],
      debounceMs: 50,
      onUpsert: r.onUpsert,
      onDelete: r.onDelete,
    });
    stop();
    stop(); // shutdown may run twice on SIGINT-then-SIGTERM; a throw here would abort the drain
    writeFileSync(join(root, "after-stop.md"), "x", "utf8");
    await r.settle(1, 600);
    expect(r.upserts).toEqual([]);
    expect(r.deletes).toEqual([]);
  });

  it("drops a pending debounce on stop rather than flushing after shutdown", async () => {
    // cli.ts calls stop() BEFORE indexCoordinator.idle(). If a queued flush still fired here it
    // would enqueue coordinator work after the drain had already been asked to settle.
    const root = makeVault();
    const r = recorder();
    const stop = startVaultWatch({
      targets: [{ vaultId: "v1", root }],
      debounceMs: 2000,
      onUpsert: r.onUpsert,
      onDelete: r.onDelete,
    });
    await arm();
    writeFileSync(join(root, "queued.md"), "x", "utf8");
    await new Promise((res) => setTimeout(res, 300)); // event received, flush still pending
    stop();
    await new Promise((res) => setTimeout(res, 2400)); // past when the flush would have fired
    expect(r.upserts).toEqual([]);
  });
});
