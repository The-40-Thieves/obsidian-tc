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
import { normalizeWatchPath, shouldWatchPath, startVaultWatch } from "../src/vault/watcher";

function makeVault(): string {
  return mkdtempSync(join(tmpdir(), "tc-watch-"));
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
    async settle(n = 1, timeoutMs = 4000): Promise<void> {
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

describe("startVaultWatch — real filesystem", () => {
  it("reports a newly created note with its content", async () => {
    const root = makeVault();
    const r = recorder();
    const stop = startVaultWatch({
      targets: [{ vaultId: "v1", root }],
      debounceMs: 50,
      onUpsert: r.onUpsert,
      onDelete: r.onDelete,
    });
    try {
      writeFileSync(join(root, "hello.md"), "# hi", "utf8");
      await r.settle();
      expect(r.upserts).toEqual([["v1", "hello.md", "# hi"]]);
    } finally {
      stop();
    }
  });

  it("picks up a note created in a NESTED directory (recursive watch)", async () => {
    // The recursive flag is the load-bearing part: a sync client writes whole folders, not one
    // root-level file. Verified to work under both node and bun on Linux before relying on it.
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
      rmSync(join(root, "gone.md"));
      await r.settle();
      expect(r.deletes).toEqual([["v1", "gone.md"]]);
      expect(r.upserts).toEqual([]);
    } finally {
      stop();
    }
  });

  it("NEVER follows a symlink — it reports a delete instead of the target's content", async () => {
    // The security case. `walkVault` classifies from readdir Dirents, whose isFile() is false for a
    // symlink, so index_vault silently skips them and never reads the target. A watcher using stat
    // (which follows) would read /etc/passwd through a symlink planted in the vault and index it via
    // a path the full walk cannot reach. lstat + isFile() is what keeps the two in agreement.
    const root = makeVault();
    const outside = mkdtempSync(join(tmpdir(), "tc-outside-"));
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "SENSITIVE-OUTSIDE-VAULT", "utf8");
    const r = recorder();
    const stop = startVaultWatch({
      targets: [{ vaultId: "v1", root }],
      debounceMs: 50,
      onUpsert: r.onUpsert,
      onDelete: r.onDelete,
    });
    try {
      symlinkSync(secret, join(root, "evil.md"));
      await r.settle();
      // The strong assertion is about CONTENT: nothing from outside the vault reached a sink.
      expect(JSON.stringify(r.upserts)).not.toContain("SENSITIVE");
      expect(r.upserts).toEqual([]);
      expect(r.deletes).toEqual([["v1", "evil.md"]]);
    } finally {
      stop();
    }
  });

  it("NEVER indexes a HARD LINK to a file outside the vault", async () => {
    // The second alias, and the one an lstat-based check cannot see: a hard link IS a regular file
    // (isFile() true, nlink 2), so it reads as an ordinary note. It is a second name for an inode
    // that may live anywhere on the same filesystem, and realpath cannot dereference it — which is
    // why notes-io's assertRegularSingleLink fstats the OPEN fd and refuses nlink > 1.
    //
    // This bypass shipped in the first draft of this watcher, which called readFileSync directly and
    // reproduced only walkVault's symlink test. Routing the read through readNote — the exact
    // function indexVault uses — is what closed it.
    const root = makeVault();
    const outside = mkdtempSync(join(tmpdir(), "tc-outside-"));
    const secret = join(outside, "secret.md");
    writeFileSync(secret, "TOP-SECRET-OUTSIDE-VAULT", "utf8");
    const errs: unknown[] = [];
    const r = recorder();
    const stop = startVaultWatch({
      targets: [{ vaultId: "v1", root }],
      debounceMs: 50,
      onUpsert: r.onUpsert,
      onDelete: r.onDelete,
      onError: (e) => errs.push(e),
    });
    try {
      linkSync(secret, join(root, "innocent.md"));
      await r.settle();
      expect(JSON.stringify(r.upserts)).not.toContain("TOP-SECRET");
      expect(r.upserts).toEqual([]);
      // Fails CLOSED: evicted, not indexed...
      expect(r.deletes).toEqual([["v1", "innocent.md"]]);
      // ...and the refusal is surfaced rather than passing for an ordinary delete.
      expect(errs).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it("indexes an ordinary single-linked note — the refusal above is not just 'reads nothing'", async () => {
    // Pairs with the two alias tests. Without it, an implementation that refused EVERY file would
    // pass both of them: "did not leak" and "actually still works" are different claims.
    const root = makeVault();
    const r = recorder();
    const errs: unknown[] = [];
    const stop = startVaultWatch({
      targets: [{ vaultId: "v1", root }],
      debounceMs: 50,
      onUpsert: r.onUpsert,
      onDelete: r.onDelete,
      onError: (e) => errs.push(e),
    });
    try {
      writeFileSync(join(root, "ordinary.md"), "plain content", "utf8");
      await r.settle();
      expect(r.upserts).toEqual([["v1", "ordinary.md", "plain content"]]);
      expect(r.deletes).toEqual([]);
      expect(errs).toEqual([]);
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
      for (const c of ["v1", "v2", "v3", "v4"]) {
        writeFileSync(join(root, "busy.md"), c, "utf8");
      }
      await r.settle();
      expect(r.upserts).toHaveLength(1);
      // Reads at flush time, so an editor's several save events cost one reindex of the end state.
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
    await r.settle(1, 500);
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
      debounceMs: 1000,
      onUpsert: r.onUpsert,
      onDelete: r.onDelete,
    });
    writeFileSync(join(root, "queued.md"), "x", "utf8");
    await new Promise((res) => setTimeout(res, 150)); // event received, flush still pending
    stop();
    await new Promise((res) => setTimeout(res, 1200)); // past when the flush would have fired
    expect(r.upserts).toEqual([]);
  });
});
