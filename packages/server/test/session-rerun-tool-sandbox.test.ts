// session_rerun (m6/admin-tools.ts) — the real-lifecycle half of its coverage session-rerun-tool-
// unit.test.ts's own header names as this file's job: a REAL `buildServerRuntime`, a REAL staged
// sandbox (session-rerun-sandbox.ts's `makeSandboxRerun`), and REAL disposal on every exit —
// success, a thrown error, and a timeout — plus the no-escalation property end to end (a caller
// whose own grant does not cover the mutating family gets that record refused, never dispatched)
// and CLI parity (the MCP tool and `rerun --sandbox --json` must report the SAME thing for the
// SAME recorded session). session-rerun-sandbox-e2e.test.ts already proves the CLI's own
// `--sandbox` routing does not touch the live vault; this file is the MCP tool's equivalent proof,
// going through `runtime.registry.dispatch("session_rerun", ...)` rather than the CLI.
//
// "No leaked `obtc-rerun-*` dir" is checked by diffing `tmpdir()` listings around each call
// (`stageSandbox`, workspace/rerun.ts, mints that exact prefix) rather than by reading the staged
// path directly — dispatch() is a black box from here, the same way a real MCP caller only ever
// sees the tool's JSON result, never the sandbox runtime session_rerun's handler built internally
// to serve it. Every case runs against a PRIVATE temp directory (`PRIVATE_TMP` below): other test
// files that also exercise `--sandbox` (e.g. session-rerun-sandbox-e2e.test.ts) mint the same
// prefix from parallel workers, and a sibling's still-live staging dir created inside this file's
// before/after window read as a leak here — measured: the "leaked" name was minted by a different
// worker pid and was already gone (ENOENT) a moment after the assertion fired.
//
// Every `after` snapshot is taken AFTER `awaitPendingSandboxCleanup()` (rerun-sandbox-cleanup.ts):
// on a platform where the synchronous `rmSync` in `safeDispose` loses to a still-closing handle
// (Windows in practice), disposal falls back to a background retry with real backoff timers rather
// than leaking the directory outright, and this flushes that retry before the assertion decides
// whether anything was actually leaked. It also flushes a timed-out call's own cleanup chain, which
// that call deliberately does not wait for before returning (session-rerun-sandbox.ts).

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { configFromVaultPath } from "../src/cli/args";
import { openConfiguredDatabase } from "../src/db/open";
import type { Database } from "../src/db/types";
import { issueElicitToken } from "../src/elicit";
import { argsHash } from "../src/hash";
import { buildServerRuntime } from "../src/runtime/server-runtime";
import {
  MAX_CONCURRENT_SANDBOX_RERUNS,
  makeSandboxRerun,
} from "../src/runtime/session-rerun-sandbox";
import { awaitPendingSandboxCleanup } from "../src/workspace/rerun-sandbox-cleanup";
import {
  appendTrace,
  cacheTraceRelPath,
  genSessionId,
  insertSession,
} from "../src/workspace/sessions";
import { stallTimeout } from "./stall-timeouts";
import { rmTemp } from "./tmp";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
// `mkdtempSync`'s own suffix is plain alphanumeric, appended with no separator — this matches
// EXACTLY `stageSandbox`'s own directories (workspace/rerun.ts's `mkdtempSync(join(tmpdir(),
// "obtc-rerun-"))`), and deliberately excludes this repo's OTHER, differently-suffixed
// "obtc-rerun-*" fixture dirs (session-rerun.test.ts's own "obtc-rerun-cache-",
// session-rerun-production-acl.test.ts's "obtc-rerun-prodacl-"/"obtc-rerun-prodacl-cache-", ...) —
// a plain prefix match caught one of those, live for that whole file's run, as a false leak when
// this file happened to run alongside it.
const RERUN_TMP_RE = /^obtc-rerun-[a-zA-Z0-9]+$/;

/** Every `stageSandbox`-minted temp dir currently under the OS temp dir — best-effort: a sibling
 *  process removing one between `readdirSync` and the filter is not this test's concern. */
// `os.tmpdir()` reads TMPDIR (POSIX) / TMP+TEMP (Windows) on every call, so pointing all three at a
// private directory for this file's lifetime scopes every `stageSandbox` mint — in-process, and in
// the CLI parity case's spawned child, which inherits this env — to a directory no other worker
// writes into. Restored in afterAll; each vitest fork runs one file, but restoring costs nothing.
const TMP_ENV_KEYS = ["TMPDIR", "TMP", "TEMP"] as const;
const savedTmpEnv = TMP_ENV_KEYS.map((k) => [k, process.env[k]] as const);
const PRIVATE_TMP = mkdtempSync(join(tmpdir(), "obtc-mcp-sbx-tmp-"));
beforeAll(() => {
  for (const k of TMP_ENV_KEYS) process.env[k] = PRIVATE_TMP;
});
afterAll(() => {
  for (const [k, v] of savedTmpEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmTemp(PRIVATE_TMP);
});

function rerunTmpEntries(): Set<string> {
  return new Set(readdirSync(tmpdir()).filter((n) => RERUN_TMP_RE.test(n)));
}

/** Asserts no `obtc-rerun-*` entry present in `after` was absent from `before` — a leak from THIS
 *  call, tolerant of unrelated ones already there (see file header). */
function assertNoNewRerunTmp(before: Set<string>, after: Set<string>): void {
  const newEntries = [...after].filter((n) => !before.has(n));
  expect(newEntries, `new obtc-rerun-* tmp entries: ${newEntries.join(", ")}`).toEqual([]);
}

interface Harness {
  vaultDir: string;
  cacheDir: string;
  db: Database;
  runtime: Awaited<ReturnType<typeof buildServerRuntime>>;
}

const tmpDirs: string[] = [];
const openDbs: Database[] = [];
const runtimes: Array<Awaited<ReturnType<typeof buildServerRuntime>>> = [];

afterEach(async () => {
  for (const db of openDbs.splice(0)) {
    try {
      db.close?.();
    } catch {
      // best-effort
    }
  }
  for (const runtime of runtimes.splice(0)) {
    try {
      await runtime.close("test cleanup");
    } catch {
      // best-effort
    }
  }
  for (const d of tmpDirs.splice(0)) {
    try {
      rmTemp(d);
    } catch {
      // best-effort, matching server-runtime.test.ts's own concession (Windows file locks)
    }
  }
});

/** Boots a REAL `ServerRuntime` against a fresh single-vault config, plus a SECOND handle onto the
 *  same live `cache.db` — the seam every seeded session and every `ctx.db` dispatch below goes
 *  through, mirroring what a live `serve` process's own caller context already carries. Seeding
 *  happens AFTER boot (not before, unlike the CLI-subprocess e2e test): boot's own
 *  `wireStoresBehindBootstrapBarrier` provisions `cache.db`, and re-provisioning it ourselves first
 *  would race that. */
async function boot(): Promise<Harness> {
  const vaultDir = mkdtempSync(join(tmpdir(), "obtc-mcp-sbx-vault-"));
  const cacheDir = mkdtempSync(join(tmpdir(), "obtc-mcp-sbx-cache-"));
  tmpDirs.push(vaultDir, cacheDir);
  const config = configFromVaultPath(vaultDir);
  config.cacheDir = cacheDir;
  const runtime = await buildServerRuntime(config, join(vaultDir, "config.json"));
  runtimes.push(runtime);
  const db = await openConfiguredDatabase(config, "cache.db");
  openDbs.push(db);
  return { vaultDir, cacheDir, db, runtime };
}

function ctxFor(db: Database, over: Record<string, unknown> = {}) {
  return {
    caller: "test",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: "main",
    db,
    ...over,
  };
}

async function mintToken(db: Database, input: Record<string, unknown>): Promise<string> {
  return issueElicitToken(db, {
    vaultId: "main",
    toolName: "session_rerun",
    argsHash: argsHash("session_rerun", input),
    caller: "test",
  });
}

/** A recorded `patch_note` — same schema-valid shape session-rerun-sandbox-e2e.test.ts's own
 *  `patchRecord` uses. */
function patchRecord(targetPath: string, ts = 1100): Record<string, unknown> {
  return {
    ts,
    type: "tool_invocation",
    tool: "patch_note",
    caller: "alice",
    status: "ok",
    args: JSON.stringify({
      vault: "main",
      path: targetPath,
      operation: "append",
      anchor: { type: "frontmatter" },
      content: "OVERWRITTEN",
    }),
    args_scan: "clean",
  };
}

/** A recorded `list_notes` — read-only, minimal args, cheap to dispatch many of in a row. Used only
 *  to PAD the timeout test's own runtime, not asserted on individually. */
function listNotesRecord(ts: number): Record<string, unknown> {
  return {
    ts,
    type: "tool_invocation",
    tool: "list_notes",
    caller: "alice",
    status: "ok",
    args: JSON.stringify({ vault: "main" }),
    args_scan: "clean",
  };
}

function seedSession(
  db: Database,
  cacheDir: string,
  records: Array<Record<string, unknown>>,
): string {
  const id = genSessionId();
  const row = insertSession(db, {
    id,
    vaultId: "main",
    caller: "alice",
    startedAt: 1000,
    tracePath: cacheTraceRelPath(id),
  });
  for (const r of records) appendTrace(join(cacheDir, row.trace_path), r as never);
  return id;
}

function un<T>(r: { ok: boolean; data?: unknown; error?: { code: string } }): T {
  if (!r.ok) throw new Error(`expected ok, got error: ${JSON.stringify(r.error)}`);
  return r.data as T;
}
function errCode(r: { ok: boolean; error?: { code: string } }): string {
  if (r.ok) throw new Error("expected an error result");
  return r.error?.code ?? "";
}

describe("session_rerun — real buildServerRuntime sandbox lifecycle", () => {
  it("success: replays a mutating call in the sandbox, leaves the real vault untouched, disposes the staging dir", {
    timeout: stallTimeout(30_000),
  }, async () => {
    const { vaultDir, cacheDir, db, runtime } = await boot();
    writeFileForVault(vaultDir, "a.md", "original");
    const id = seedSession(db, cacheDir, [patchRecord("a.md")]);
    const input = { vault: "main", session_id: id };
    const token = await mintToken(db, input);

    const before = rerunTmpEntries();
    const res = await runtime.registry.dispatch(
      "session_rerun",
      input,
      ctxFor(db, { elicitToken: token }) as never,
    );
    // Flush the timed-out call's own cleanup chain, and any deferred removal retry it fell back to
    // (Windows-only in practice — see rerun-sandbox-cleanup.ts), before deciding on a leak.
    await awaitPendingSandboxCleanup();
    const after = rerunTmpEntries();

    const data = un<{
      records: Array<{ verdict: string; replayed: { status: string } | null }>;
    }>(res as never);
    expect(data.records[0]?.verdict).toBe("runnable");
    expect(data.records[0]?.replayed?.status).toBe("ok");
    // THE property: the mutating call landed on the SANDBOX copy, not the real vault.
    expect(readFileSync(join(vaultDir, "a.md"), "utf8")).toBe("original");
    assertNoNewRerunTmp(before, after);
  });

  it("disposal on error: a directory-shaped trace path (EISDIR after staging) still disposes, never leaks", {
    timeout: stallTimeout(30_000),
  }, async () => {
    const { cacheDir, db, runtime } = await boot();
    const id = seedSession(db, cacheDir, []);
    // Replace the trace FILE with a directory. `stageSandbox` copies whatever is there
    // (workspace/rerun.ts's `cpSync(tracesSrc, ...)`), so the staged copy inherits the same shape,
    // and `readTrace`'s `readFileSync` throws EISDIR on it — see workspace/sessions.ts.
    const tracePath = join(cacheDir, cacheTraceRelPath(id));
    rmSync(tracePath, { force: true });
    mkdirSync(tracePath, { recursive: true });
    const input = { vault: "main", session_id: id };
    const token = await mintToken(db, input);

    const before = rerunTmpEntries();
    const res = await runtime.registry.dispatch(
      "session_rerun",
      input,
      ctxFor(db, { elicitToken: token }) as never,
    );
    // Flush the timed-out call's own cleanup chain, and any deferred removal retry it fell back to
    // (Windows-only in practice — see rerun-sandbox-cleanup.ts), before deciding on a leak.
    await awaitPendingSandboxCleanup();
    const after = rerunTmpEntries();

    // EISDIR is a raw fs error, not an ObsidianTcError — dispatch's catch-all reports it as
    // "internal" (same code the unwired-dependency case gets in session-rerun-tool-unit.test.ts).
    expect(errCode(res as never)).toBe("internal");
    assertNoNewRerunTmp(before, after);
  });

  it("disposal on timeout: a 1ms budget times out, cancels the loop, and still disposes cleanly", {
    timeout: stallTimeout(30_000),
  }, async () => {
    const { cacheDir, db, runtime } = await boot();
    // Padding rationale: `makeSandboxRerun`'s RACE (the error the CALLER sees) wraps ONLY
    // `rerunSession` itself, not staging or the second runtime build (session-rerun-sandbox.ts's
    // own doc comment) — those already dwarf 1ms on their own, so a timeout would "pass" even if
    // the race were wired to the wrong span. Seeding several real, dispatched records — each
    // preceded by the per-record `setImmediate` yield rerunSession's own loop does (workspace/
    // rerun.ts) — gives a 1ms timeout several real chances to preempt mid-loop, proving the race
    // covers the right span rather than just that 1ms is small. Disposal itself is a SEPARATE
    // question from the race: `makeSandboxRerun` does not remove the staged directory until `work`
    // (staging + boot + this loop) has actually stopped — `cancelled` (set the instant the timeout
    // fires) is what keeps that fast once the loop is reached, per its own doc comment.
    const records = Array.from({ length: 50 }, (_, i) => listNotesRecord(1000 + i));
    const id = seedSession(db, cacheDir, records);
    const input = { vault: "main", session_id: id, timeout_ms: 1 };
    const token = await mintToken(db, input);

    const before = rerunTmpEntries();
    const res = await runtime.registry.dispatch(
      "session_rerun",
      input,
      ctxFor(db, { elicitToken: token }) as never,
    );
    // Flush the timed-out call's own cleanup chain, and any deferred removal retry it fell back to
    // (Windows-only in practice — see rerun-sandbox-cleanup.ts), before deciding on a leak.
    await awaitPendingSandboxCleanup();
    const after = rerunTmpEntries();

    expect(errCode(res as never)).toBe("operation_timeout");
    // A timed-out call returns at its deadline, before its cleanup chain (wait for `work`, close,
    // dispose) finishes — `awaitPendingSandboxCleanup()` above is what flushes that chain, so by
    // `after` disposal has already been attempted (session-rerun-sandbox.ts's own doc comment).
    assertNoNewRerunTmp(before, after);
  });

  it("no scope escalation end-to-end: a read-only caller's recorded mutating call is refused, never executed", {
    timeout: stallTimeout(30_000),
  }, async () => {
    const { vaultDir, cacheDir, db, runtime } = await boot();
    writeFileForVault(vaultDir, "a.md", "original");
    const id = seedSession(db, cacheDir, [patchRecord("a.md")]);
    const input = { vault: "main", session_id: id };
    const token = await mintToken(db, input);

    // admin:rerun clears the TOOL's own scope gate; read:* is everything this caller can replay —
    // intersectReplayScopes(granted) narrows to ["read:*"], so the write-family patch_note record
    // must be refused by RERUN's own policy, never by the vault.
    const res = await runtime.registry.dispatch(
      "session_rerun",
      input,
      ctxFor(db, {
        grantedScopes: new Set(["read:*", "admin:rerun"]),
        elicitToken: token,
      }) as never,
    );

    const data = un<{
      records: Array<{ verdict: string; replayed: unknown; reason: string }>;
    }>(res as never);
    // `replayed: null` is the direct evidence the mutating handler never ran at all (dispatch's own
    // scope gate refused it before patch_note's handler was reached) — not just that the vault
    // happens to be unchanged, which sandboxing alone would already guarantee.
    expect(data.records[0]?.verdict).toBe("refused_by_policy");
    expect(data.records[0]?.replayed).toBeNull();
    expect(readFileSync(join(vaultDir, "a.md"), "utf8")).toBe("original");
  });

  it("CLI parity: the MCP tool and `rerun --sandbox --json` report the same records/summary for the same session", async () => {
    const { vaultDir, cacheDir, db, runtime } = await boot();
    writeFileForVault(vaultDir, "a.md", "original");
    const id = seedSession(db, cacheDir, [patchRecord("a.md")]);
    const input = { vault: "main", session_id: id };
    const token = await mintToken(db, input);

    const toolRes = await runtime.registry.dispatch(
      "session_rerun",
      input,
      ctxFor(db, { elicitToken: token }) as never,
    );
    const toolData = un<{
      records: unknown;
      summary: unknown;
    }>(toolRes as never);
    // JSON round-trip the tool side too: the CLI's own output already went through
    // `JSON.stringify` (cli/commands/rerun.ts), which drops explicit-`undefined` object keys
    // (`recorded.duration_ms`/`result_size` for a seeded record that never set them) — comparing a
    // raw in-process object against a JSON-parsed one would otherwise fail on that boundary
    // artifact alone, not on anything either side actually disagrees about.
    const toolJson = JSON.parse(JSON.stringify(toolData)) as {
      records: Array<Record<string, unknown>>;
      summary: unknown;
    };
    // Close the tool-side runtime/db BEFORE spawning the CLI against the same cacheDir/vaultDir —
    // sequential, not concurrent, access to the same sqlite files (Windows-safe; matches this
    // file's own afterEach ordering).
    await runtime.close("cli parity: tool side done");
    db.close?.();
    runtimes.splice(runtimes.indexOf(runtime), 1);
    openDbs.splice(openDbs.indexOf(db), 1);

    const confDir = mkdtempSync(join(tmpdir(), "obtc-mcp-sbx-conf-"));
    tmpDirs.push(confDir);
    const configPath = join(confDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ cacheDir, vaults: [{ id: "main", path: vaultDir }] }),
    );
    const cli = spawnSync(
      "bun",
      [CLI, "rerun", id, "--config", configPath, "--vault", "main", "--sandbox", "--json"],
      { encoding: "utf8", timeout: 60_000, env: { ...process.env, NO_COLOR: "1" } },
    );
    expect(cli.status, `rerun exited ${cli.status}, stderr: ${cli.stderr}`).toBe(0);
    const cliData = JSON.parse(cli.stdout) as {
      records: Array<Record<string, unknown>>;
      summary: unknown;
    };

    // `replayed.duration_ms` is real wall-clock, measured independently by two separate processes
    // — workspace/rerun.ts's own header already treats it as reported-not-asserted for the same
    // reason. Every other field (status, result_size, verdict, divergence, ...) is deterministic
    // given the same seeded session and starting vault state, so THAT is what parity means here.
    const withoutDuration = (records: Array<Record<string, unknown>>) =>
      records.map((r) => {
        const replayed = r.replayed as Record<string, unknown> | null;
        return { ...r, replayed: replayed ? { ...replayed, duration_ms: undefined } : replayed };
      });

    expect(withoutDuration(cliData.records)).toEqual(withoutDuration(toolJson.records));
    expect(cliData.summary).toEqual(toolJson.summary);
  }, 60_000);

  it("closes a runtime built after the timeout fired, before disposing its staged dir", {
    timeout: stallTimeout(30_000),
  }, async () => {
    // A 1ms budget fires while `work` is still staging, so the sandbox runtime does not exist yet
    // when the timeout lands — it is built afterwards, while `makeSandboxRerun` waits for `work` to
    // settle. That late runtime must still be closed (its vault-lock keepalive, lock db, cache.db
    // and experiential.db handles all live in the staged dir), and closed BEFORE the dir is removed:
    // on Windows an open handle blocks the unlink outright.
    const { vaultDir, cacheDir, db } = await boot();
    const id = seedSession(db, cacheDir, [listNotesRecord(1000)]);
    const config = configFromVaultPath(vaultDir);
    config.cacheDir = cacheDir;
    const events: string[] = [];
    const rerun = makeSandboxRerun(config, join(vaultDir, "config.json"), async (cfg, cp) => {
      const rt = await buildServerRuntime(cfg, cp);
      runtimes.push(rt); // afterEach still closes it if the code under test never does
      events.push("built");
      return {
        registry: rt.registry,
        close: async (reason: string) => {
          events.push(existsSync(cfg.cacheDir) ? "close:staged-dir-present" : "close:dir-gone");
          await rt.close(reason);
        },
      };
    });

    await expect(
      rerun({ vaultId: "main", sessionId: id, replayScopes: ["read:*"], timeoutMs: 1 }),
    ).rejects.toThrow(/sandbox timeout/);
    await awaitPendingSandboxCleanup(); // a timed-out call returns BEFORE its cleanup finishes
    expect(events).toEqual(["built", "close:staged-dir-present"]);
  });

  it("no writes after close: close() joins every background writer a sandbox-shaped runtime started", {
    timeout: stallTimeout(30_000),
  }, async () => {
    // A runtime built but never start()ed — exactly the shape `makeSandboxRerun` builds — still
    // starts the vault-lock leader election (a 1s keepalive) and holds cache.db/experiential.db.
    // Once close() resolves nothing it started may touch its cacheDir again, or disposing that
    // dir right after close() races a live writer.
    const { cacheDir, runtime } = await boot();
    await runtime.close("test: no writes after close");
    const snapshot = (): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const rel of readdirSync(cacheDir, { recursive: true }) as string[]) {
        const st = statSync(join(cacheDir, rel));
        out[rel] = `${st.size}:${st.mtimeMs}`;
      }
      return out;
    };
    const before = snapshot();
    await new Promise((r) => setTimeout(r, 2500)); // > 2x vault-lock.ts's 1000ms KEEPALIVE_MS
    expect(snapshot()).toEqual(before);
  });

  it("hung boot: the call still returns operation_timeout at its deadline, and cleanup runs once the boot settles", {
    timeout: stallTimeout(30_000),
  }, async () => {
    const { vaultDir, cacheDir, db } = await boot();
    const id = seedSession(db, cacheDir, [listNotesRecord(1000)]);
    const config = configFromVaultPath(vaultDir);
    config.cacheDir = cacheDir;
    const boot$ = openableGate();
    const events: string[] = [];
    let stagedCacheDir = "";
    const rerun = makeSandboxRerun(config, join(vaultDir, "config.json"), async (cfg) => {
      stagedCacheDir = cfg.cacheDir;
      await boot$.wait; // a second boot that does not finish until the test lets it
      events.push("built");
      return { registry: {} as never, close: async () => void events.push("closed") };
    });

    const call = rerun({
      vaultId: "main",
      sessionId: id,
      replayScopes: ["read:*"],
      timeoutMs: 200,
    });
    // Staging is inside the budget too, so the deadline lands well inside this window; the
    // sentinel is only there so a regression reads as a failed assertion, not a hung test.
    const outcome = await Promise.race([
      call.then(
        () => "resolved",
        (e: { code?: string }) => e.code,
      ),
      new Promise((r) => setTimeout(() => r("still pending"), 5_000)),
    ]);
    expect(outcome).toBe("operation_timeout");
    expect(events).toEqual([]); // the boot really was still hung when the caller got its answer

    boot$.open();
    await awaitPendingSandboxCleanup();
    expect(events).toEqual(["built", "closed"]);
    expect(stagedCacheDir).not.toBe("");
    expect(existsSync(stagedCacheDir)).toBe(false);
  });

  it("concurrency cap: calls beyond MAX_CONCURRENT_SANDBOX_RERUNS are refused as throttled, and a slot frees once cleanup finishes", async () => {
    const { vaultDir, cacheDir, db } = await boot();
    const id = seedSession(db, cacheDir, [listNotesRecord(1000)]);
    const config = configFromVaultPath(vaultDir);
    config.cacheDir = cacheDir;
    const boot$ = openableGate();
    const rerun = makeSandboxRerun(config, join(vaultDir, "config.json"), async () => {
      await boot$.wait;
      return { registry: {} as never, close: async () => {} };
    });
    const params = { vaultId: "main", sessionId: id, replayScopes: ["read:*"], timeoutMs: 20_000 };

    const inFlight = Array.from({ length: MAX_CONCURRENT_SANDBOX_RERUNS }, () =>
      rerun(params).catch((e: unknown) => e),
    );
    await expect(rerun(params)).rejects.toMatchObject({ code: "throttled" });

    boot$.open();
    await Promise.all(inFlight);
    await awaitPendingSandboxCleanup();
    // Every slot is free again: the next call is admitted (and fails for its own stub-registry
    // reason, never for the cap).
    const again = await rerun(params).catch((e: { code?: string }) => e);
    expect((again as { code?: string }).code).not.toBe("throttled");
    await awaitPendingSandboxCleanup();
  }, 60_000);
});

/** A promise the test resolves by hand — stands in for a sandbox boot that hangs until released. */
function openableGate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

function writeFileForVault(vaultDir: string, rel: string, content: string): void {
  writeFileSync(join(vaultDir, rel), content);
}
