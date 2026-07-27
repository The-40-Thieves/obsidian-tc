// THE-649: the filesystem watch that docs/SYNC.md has always described and that did not exist.
//
// Two layers, deliberately separated. `shouldWatchPath` is pure policy and is tested exhaustively
// without touching a disk — that is where the security-relevant rules live. `startVaultWatch` is
// tested against a REAL filesystem, because the whole feature is an assertion about what the OS
// reports; a mocked fs.watch would only prove the test's own model of inotify.
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizeWatchPath,
  resolveWatchedPath,
  shouldWatchPath,
  startVaultWatch,
} from "../src/vault/watcher";

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
  rmSync(probe, { recursive: true, force: true });
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
    // Generous by default: FSEvents on macOS coalesces with its own latency window on top of ours,
    // and CI runners are slower than this box. The tests that assert "exactly one" still catch a
    // second call via the trailing wait below, so a long ceiling costs nothing but patience.
    async settle(n = 1, timeoutMs = 10_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (upserts.length + deletes.length < n && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      // One more debounce window, so a test asserting "exactly one" can still catch a second call.
      await new Promise((r) => setTimeout(r, 120));
    },
  };
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
      expect(r.upserts).toEqual([["v1", "Projects/Deep/n.md", "deep"]]);
    } finally {
      stop();
    }
  });

  it("reports a deleted note as a delete, not an upsert", async () => {
    const root = makeVault();
    writeFileSync(join(root, "gone.md"), "bye", "utf8");
    const r = recorder();
    const stop = startVaultWatch({
      targets: [{ vaultId: "v1", root }],
      debounceMs: 50,
      onUpsert: r.onUpsert,
      onDelete: r.onDelete,
    });
    try {
      await arm();
      rmSync(join(root, "gone.md"));
      await r.settle();
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
      expect(r.upserts).toEqual([["v1", "real.md", "real"]]);
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
      expect([...r.upserts].sort()).toEqual([
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
      expect(r.upserts).toEqual([["good", "still-works.md", "ok"]]);
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
