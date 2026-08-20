// THE-645 item 3 — the runner.
//
// The load-bearing test here is "observe mode does not write", and it asserts the NOTE ON DISK,
// not the verdict string. A runner that classified correctly and then dispatched anyway would
// satisfy a verdict assertion perfectly — the report and the behaviour are independent.
//
// FIXTURE: `makeTestVault` (m1-helpers), NOT `makeM5Vault`. makeM5Vault registers only M5 tools, so
// a `patch_note` test against it passes VACUOUSLY — the tool is not registered, nothing writes,
// green — and the mutation below would not go red either. makeTestVault registers M1 tools, takes
// `acl: { readOnly: true }`, and builds its ToolRegistry with NO aclResolver (m1-helpers.ts:75), so
// nothing swaps ctx.acl mid-dispatch.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withReadOnlyAcl } from "../src/cli/commands/rerun";
import { openDatabase } from "../src/db/open";
import {
  RERUN_CALLER_PREFIX,
  rerunCaller,
  rerunSession,
  stageSandbox,
} from "../src/workspace/rerun";
import {
  exitCodeFor,
  RERUN_EXIT_OPERATIONAL,
  type RerunRecord,
  type RerunVerdict,
  summarizeRerun,
} from "../src/workspace/rerun-verdict";
import { appendTrace, insertSession } from "../src/workspace/sessions";
import { makeTestVault, type TestVault } from "./m1-helpers";

let v: TestVault | undefined;
let cacheDir: string | undefined;
/** Extra temp roots a single test creates (e.g. the `add_vault` target). */
const dirsToClean: string[] = [];
afterEach(() => {
  v?.cleanup();
  if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
  cacheDir = undefined;
  for (const d of dirsToClean.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A vault whose ACL is read-only unless `writable` — the mutation in Step 5 flips this. */
function readOnlyVault(files: Record<string, string>, writable = false): TestVault {
  cacheDir = mkdtempSync(join(tmpdir(), "obtc-rerun-cache-"));
  return makeTestVault({ files, acl: { readOnly: !writable } });
}

/** Open a session row and write `records` into its trace file. Returns the session id. */
function seedSession(vault: TestVault, records: Array<Record<string, unknown>>, tag = ""): string {
  const id = `sess_rerun_${tag}${records.length}`;
  const row = insertSession(vault.db, {
    id,
    vaultId: vault.id,
    caller: "alice",
    startedAt: 1000,
    tracePath: `traces/${id}.jsonl`,
  });
  const abs = join(cacheDir as string, row.trace_path);
  for (const r of records) appendTrace(abs, r as never);
  return id;
}

/** A schema-valid `patch_note` trace record. `vault` is a parameter because a record naming a
 *  vault OTHER than the session's own is exactly what the vault-binding tests below need. */
function patchRecord(vaultId: string, recordedStatus = "ok"): Record<string, unknown> {
  return {
    ts: 1100,
    type: "tool_invocation",
    tool: "patch_note",
    caller: "alice",
    status: recordedStatus,
    args: JSON.stringify({
      vault: vaultId,
      path: "a.md",
      operation: "append",
      anchor: { type: "frontmatter" },
      content: "OVERWRITTEN",
    }),
    args_scan: "clean",
  };
}

describe("THE-645 item 3 — rerun in observe mode", () => {
  it("re-issues a clean read and reports no divergence", async () => {
    v = readOnlyVault({ "a.md": "hello" });
    const id = seedSession(v, [
      {
        ts: 1100,
        type: "tool_invocation",
        tool: "read_note",
        caller: "alice",
        status: "ok",
        result_size: 5,
        args: JSON.stringify({ vault: v.id, path: "a.md" }),
        args_scan: "clean",
      },
    ]);

    const out = await rerunSession({
      db: v.db,
      registry: v.registry,
      sessionId: id,
      cacheDir: cacheDir as string,
      vaultRootFor: () => (v as TestVault).root,
    });

    expect(out.summary.runnable).toBe(1);
    expect(out.records[0]?.verdict).toBe("runnable");
    expect(out.records[0]?.divergence).toBe("none");
  });

  it("DOES NOT WRITE in observe mode — asserted on the note, not on the verdict", async () => {
    v = readOnlyVault({ "a.md": "original" });
    const id = seedSession(v, [
      {
        ts: 1100,
        type: "tool_invocation",
        tool: "patch_note",
        caller: "alice",
        status: "ok",
        // NOTE: `operation`/`anchor` are required by PatchInput (schemas.ts) — an incomplete
        // payload here would be refused at parseInput (validation_error) before either the scope
        // or ACL gate is ever reached, which would make this test pass for the wrong reason.
        args: JSON.stringify({
          vault: v.id,
          path: "a.md",
          operation: "append",
          anchor: { type: "frontmatter" },
          content: "OVERWRITTEN",
        }),
        args_scan: "clean",
      },
    ]);

    await rerunSession({
      db: v.db,
      registry: v.registry,
      sessionId: id,
      cacheDir: cacheDir as string,
      vaultRootFor: () => (v as TestVault).root,
    });

    // THE property. Not `verdict === "skipped_mutating"` — that only proves the runner printed
    // the right word.
    expect(v.read("a.md")).toBe("original");
  });

  it("records the mutating skip as dispatch's ruling, with the note still intact", async () => {
    v = readOnlyVault({ "a.md": "original" });
    const id = seedSession(v, [
      {
        ts: 1100,
        type: "tool_invocation",
        tool: "patch_note",
        caller: "alice",
        status: "ok",
        args: JSON.stringify({
          vault: v.id,
          path: "a.md",
          operation: "append",
          anchor: { type: "frontmatter" },
          content: "OVERWRITTEN",
        }),
        args_scan: "clean",
      },
    ]);
    const out = await rerunSession({
      db: v.db,
      registry: v.registry,
      sessionId: id,
      cacheDir: cacheDir as string,
      vaultRootFor: () => (v as TestVault).root,
    });
    expect(out.records[0]?.verdict).toBe("skipped_mutating");
    expect(out.summary.runnable).toBe(0);
    expect(v.read("a.md")).toBe("original");
  });

  it("a refused record reaches no dispatch at all", async () => {
    v = readOnlyVault({ "a.md": "original" });
    const id = seedSession(v, [
      {
        ts: 1100,
        type: "tool_invocation",
        tool: "patch_note",
        caller: "alice",
        args: JSON.stringify({ vault: v.id, path: "a.md", content: "[REDACTED]" }),
        args_scan: "redacted:1",
      },
    ]);
    // Spy rather than inferring from effect: "it didn't write" could otherwise pass because the
    // write happened to fail for an unrelated reason.
    const seen: string[] = [];
    const spied = {
      dispatch: (name: string, ...rest: unknown[]) => {
        seen.push(name);
        return (v as TestVault).registry.dispatch(name, ...(rest as [never, never]));
      },
    } as unknown as TestVault["registry"];

    const out = await rerunSession({
      db: v.db,
      registry: spied,
      sessionId: id,
      cacheDir: cacheDir as string,
      vaultRootFor: () => (v as TestVault).root,
    });
    expect(out.records[0]?.verdict).toBe("redacted");
    expect(seen).toEqual([]);
  });

  it("THE-741: a cache-served replay reports served_from_cache — not runnable — and re-verifies nothing", async () => {
    // dispatch's idempotency gate stamps `meta.idempotent_replay` when it serves a cached result
    // instead of running the handler (registry/dispatch.ts). Stubbed here rather than actually
    // claiming a real idempotency key: this isolates rerun.ts's CLASSIFICATION of that marker from
    // dispatch.ts's STAMPING of it, which idempotency.test.ts covers directly against the real
    // gate. Before THE-741 this record read `verdict: "runnable"` / `divergence: "none"` — the
    // exact silent-pass the ticket exists to close.
    v = readOnlyVault({ "a.md": "original" });
    const id = seedSession(v, [
      {
        ts: 1100,
        type: "tool_invocation",
        tool: "read_note",
        caller: "alice",
        status: "ok",
        result_size: 5,
        args: JSON.stringify({ vault: v.id, path: "a.md" }),
        args_scan: "clean",
      },
    ]);
    const cachedDispatch = {
      dispatch: async () => ({
        ok: true,
        data: { cached: true },
        meta: { duration_ms: 1, result_size: 9, idempotent_replay: true },
      }),
    } as unknown as TestVault["registry"];

    const out = await rerunSession({
      db: v.db,
      registry: cachedDispatch,
      sessionId: id,
      cacheDir: cacheDir as string,
      vaultRootFor: () => (v as TestVault).root,
    });

    expect(out.records[0]?.verdict).toBe("served_from_cache");
    expect(out.records[0]?.replayed).toBeNull();
    expect(out.records[0]?.divergence).toBe("none");
    expect(out.summary.runnable).toBe(0);
    expect(out.summary.diverged).toBe(0);
    expect(out.summary.byVerdict.served_from_cache).toBe(1);
    // Honest, not a pass: served-from-cache re-verified nothing, so it must not count toward
    // "runnable" — exit 2 ("nothing was runnable") over exit 0 ("ran, nothing moved").
    expect(exitCodeFor(out.summary)).toBe(2);
  });

  it("an unknown session id is an error, not an empty successful run", async () => {
    v = readOnlyVault({});
    await expect(
      rerunSession({
        db: v.db,
        registry: v.registry,
        sessionId: "nope",
        cacheDir: cacheDir as string,
        vaultRootFor: () => (v as TestVault).root,
      }),
    ).rejects.toThrow(/unknown session/i);
  });

  it("--vault mismatch throws rather than re-running against the wrong vault", async () => {
    v = readOnlyVault({ "a.md": "x" });
    const id = seedSession(v, []);
    await expect(
      rerunSession({
        db: v.db,
        registry: v.registry,
        sessionId: id,
        cacheDir: cacheDir as string,
        vaultRootFor: () => (v as TestVault).root,
        expectVaultId: "some-other-vault",
      }),
    ).rejects.toThrow(/belongs to vault/i);
  });
});

describe("THE-645 item 3 fix round 2 — what observe mode must refuse, and what it must not relabel", () => {
  // FINDING 3. `trace_store` is `DEFAULT 'vault'` in migration 20260805_003, so EVERY session row
  // predating THE-737 reads that way. Observe mode passed no vault root at all, so
  // `resolveTraceAbs` resolved such a row against `resolve("")` = process.cwd(), `readTrace`
  // returned [] for the missing file, and the command told the operator `sessions.traceContent`
  // had been off when the session was recorded. It had not been — the same session read fine under
  // `--sandbox`, the one mode that did pass a root.
  it("reads a legacy trace_store='vault' session in observe mode", async () => {
    v = readOnlyVault({ "a.md": "hello" });
    const id = "sess_rerun_legacy_vault_store";
    const rel = ".obsidian-tc/traces/legacy.jsonl";
    insertSession(v.db, {
      id,
      vaultId: v.id,
      caller: "alice",
      startedAt: 1000,
      tracePath: rel,
      traceStore: "vault",
    });
    appendTrace(join(v.root, rel), {
      ts: 1100,
      type: "tool_invocation",
      tool: "read_note",
      caller: "alice",
      status: "ok",
      args: JSON.stringify({ vault: v.id, path: "a.md" }),
      args_scan: "clean",
    } as never);

    const out = await rerunSession({
      db: v.db,
      registry: v.registry,
      sessionId: id,
      cacheDir: cacheDir as string,
      vaultRootFor: () => (v as TestVault).root,
    });

    // Non-vacuous: the record was found AND dispatched. Before the fix this was `total 0`, which
    // the CLI then reported as "nothing was runnable — traceContent was off".
    expect(out.summary.total).toBe(1);
    expect(out.summary.runnable).toBe(1);
    expect(out.records[0]?.verdict).toBe("runnable");
  });

  // FINDINGS 4 + 5. `MUTATING_FAMILIES` omits `admin`, so `isMutatingCall` is false for an
  // `admin:`-scoped tool and `enforceReadOnlyGate` never fires — observe mode dispatched a
  // recorded `add_vault` for real, registering an operator-supplied path into the live registry.
  // Closed at the SCOPE gate (RERUN_SCOPES omits admin) rather than by widening
  // MUTATING_FAMILIES, which would change behaviour for the whole server.
  it("refuses a recorded admin: call, and does not register the vault", async () => {
    v = readOnlyVault({ "a.md": "hello" });
    const intruderRoot = mkdtempSync(join(tmpdir(), "obtc-rerun-intruder-"));
    dirsToClean.push(intruderRoot);
    const id = seedSession(
      v,
      [
        {
          ts: 1100,
          type: "tool_invocation",
          tool: "add_vault",
          caller: "alice",
          status: "ok",
          args: JSON.stringify({ vault_id: "intruder", path: intruderRoot, kind: "private" }),
          args_scan: "clean",
        },
      ],
      "admin_",
    );

    const out = await rerunSession({
      db: v.db,
      registry: v.registry,
      sessionId: id,
      cacheDir: cacheDir as string,
      vaultRootFor: () => (v as TestVault).root,
    });

    // THE-738: this is now `refused_by_policy`, not a divergence. The refusal is unchanged — the
    // scope gate still stops the call — but it is RERUN'S OWN refusal (RERUN_SCOPES omits admin),
    // so reporting it as "the vault answered differently" was wrong and flipped the exit code to 1
    // on a run where nothing had moved.
    expect(out.records[0]?.verdict).toBe("refused_by_policy");
    expect(out.records[0]?.divergence).toBe("none");
    expect(exitCodeFor(out.summary)).not.toBe(1);
    // THE property — and note it is unchanged by any of the above, which is the point. `add_vault`
    // declares no `vaultArg`, so the vault-binding guard cannot see it; the scope gate is the only
    // thing that stops it. How the refusal is REPORTED must never affect whether it HAPPENS.
    expect(v.vaultRegistry.has("intruder")).toBe(false);
  });

  // FINDING 1 (unit half; the e2e half lives in session-rerun-sandbox-e2e.test.ts) and FINDING 6.
  // A record whose captured args name a DIFFERENT vault is refused by `enforceVaultBinding`, which
  // runs BEFORE the read-only gate — so its `forbidden` is NOT the read-only gate's. It must be
  // reported as a real, diverging outcome; folding every `forbidden` into `skipped_mutating`
  // reported this genuine refusal as an expected skip that counted toward neither `diverged` nor
  // the exit code.
  it("a mutating record naming another vault is a DIVERGENCE, not an expected skip", async () => {
    v = readOnlyVault({ "a.md": "original" });
    const id = seedSession(v, [patchRecord("some-other-vault")], "xvault_");

    const out = await rerunSession({
      db: v.db,
      registry: v.registry,
      sessionId: id,
      cacheDir: cacheDir as string,
      vaultRootFor: () => (v as TestVault).root,
    });

    expect(out.records[0]?.verdict).toBe("runnable");
    expect(out.records[0]?.verdict).not.toBe("skipped_mutating");
    expect(out.records[0]?.replayed?.error_code).toBe("forbidden");
    expect(out.records[0]?.divergence).toBe("status");
    expect(out.summary.diverged).toBe(1);
    expect(exitCodeFor(out.summary)).toBe(1);
  });

  // The other half of the same discrimination: the read-only gate's OWN refusal must still be a
  // skip. Without this, "report every forbidden as a divergence" would also pass the test above.
  it("still reports the read-only gate's own refusal as skipped_mutating", async () => {
    v = readOnlyVault({ "a.md": "original" });
    const id = seedSession(v, [patchRecord(v.id)], "ro_");

    const out = await rerunSession({
      db: v.db,
      registry: v.registry,
      sessionId: id,
      cacheDir: cacheDir as string,
      vaultRootFor: () => (v as TestVault).root,
    });

    expect(out.records[0]?.verdict).toBe("skipped_mutating");
    expect(out.summary.diverged).toBe(0);
    expect(v.read("a.md")).toBe("original");
  });
});

describe("THE-645 item 3 — withReadOnlyAcl", () => {
  it("forces readOnly on the ROOT acl", () => {
    const out = withReadOnlyAcl({
      acl: { readOnly: false, defaultScopes: [], rules: [] },
      vaults: [{ id: "a", root: "/tmp/a" }],
    } as never);
    expect(out.acl.readOnly).toBe(true);
  });

  it("forces readOnly on a vault's OWN acl block — the root alone would leave it writable", () => {
    // The naive implementation forces only the root. A vault with its own acl OVERRIDES the root,
    // so that vault would still write for real while the run reported a clean observe-mode pass.
    const out = withReadOnlyAcl({
      acl: { readOnly: false, defaultScopes: [], rules: [] },
      vaults: [
        { id: "a", root: "/tmp/a" },
        { id: "b", root: "/tmp/b", acl: { readOnly: false, defaultScopes: [], rules: [] } },
      ],
    } as never);
    expect(out.vaults[1]?.acl?.readOnly).toBe(true);
  });

  it("leaves a vault with no acl block alone — it inherits the now-read-only root", () => {
    const out = withReadOnlyAcl({
      acl: { readOnly: false, defaultScopes: [], rules: [] },
      vaults: [{ id: "a", root: "/tmp/a" }],
    } as never);
    expect(out.vaults[0]?.acl).toBeUndefined();
  });

  it("does not mutate the input config", () => {
    const cfg = {
      acl: { readOnly: false, defaultScopes: [], rules: [] },
      vaults: [{ id: "b", root: "/tmp/b", acl: { readOnly: false, defaultScopes: [], rules: [] } }],
    } as never;
    withReadOnlyAcl(cfg);
    const original = cfg as {
      acl: { readOnly: boolean };
      vaults: [{ acl: { readOnly: boolean } }];
    };
    expect(original.acl.readOnly).toBe(false);
    // Fix round 1, finding 5: the per-vault block is exactly what a buggy in-place implementation
    // (e.g. `v.acl.readOnly = true` instead of spreading a new object) would mutate silently — the
    // root-only assertion above would not catch that class of bug at all.
    expect(original.vaults[0].acl.readOnly).toBe(false);
  });
});

describe("THE-738 — rerun's own refusals are not divergence, and exit 1 means one thing", () => {
  it("counts refused_by_policy separately, and it does NOT flip the exit code", () => {
    const rec = (verdict: RerunVerdict, divergence: string): RerunRecord =>
      ({
        seq: 0,
        ts: 0,
        tool: "t",
        caller: null,
        recorded: {},
        verdict,
        reason: "",
        replayed: null,
        divergence,
      }) as unknown as RerunRecord;

    // A run where every non-runnable call was refused BY RERUN must not report divergence: this
    // is the whole defect — read-only m4 bridge tools under --sandbox, and admin: calls in observe
    // mode, were each reported as "the vault changed".
    const s = summarizeRerun([rec("runnable", "none"), rec("refused_by_policy", "none")]);
    expect(s.byVerdict.refused_by_policy).toBe(1);
    expect(s.diverged).toBe(0);
    expect(exitCodeFor(s)).toBe(0);
  });

  it("still reports a REAL divergence — the refusal carve-out must not swallow one", () => {
    const rec = (verdict: RerunVerdict, divergence: string): RerunRecord =>
      ({
        seq: 0,
        ts: 0,
        tool: "t",
        caller: null,
        recorded: {},
        verdict,
        reason: "",
        replayed: null,
        divergence,
      }) as unknown as RerunRecord;
    const s = summarizeRerun([rec("runnable", "status"), rec("refused_by_policy", "none")]);
    expect(s.diverged).toBe(1);
    expect(exitCodeFor(s)).toBe(1);
  });

  it("gives operational failure its OWN code, distinct from divergence", () => {
    // The collision this closes: a thrown error used to exit 1, the same as "the vault changed",
    // so a script gating on $? -eq 1 could not tell them apart.
    expect(RERUN_EXIT_OPERATIONAL).toBe(3);
    expect(RERUN_EXIT_OPERATIONAL).not.toBe(1);
    // and the three verdict-derived codes stay what they were
    const none = summarizeRerun([]);
    expect(exitCodeFor(none)).toBe(2);
  });
});

describe("THE-740 — replayed calls are attributable, not indistinguishable", () => {
  it("prefixes the caller so synthetic event_log rows are excludable", () => {
    expect(rerunCaller("alice")).toBe("rerun:alice");
    // The original principal stays legible — that is why a prefix beat a new column.
    expect(rerunCaller("alice").endsWith("alice")).toBe(true);
    expect(rerunCaller("alice").startsWith(RERUN_CALLER_PREFIX)).toBe(true);
  });

  it("never leaves a replayed row indistinguishable from an unattributed real one", () => {
    // A null caller must NOT stay null: an un-prefixed null row is exactly what a real
    // unattributed call writes, so the two would be impossible to tell apart afterwards.
    expect(rerunCaller(null)).toBe("rerun:");
    expect(rerunCaller(null)).not.toBe(null);
    expect(rerunCaller(null).startsWith(RERUN_CALLER_PREFIX)).toBe(true);
  });
});

describe("THE-645 item 3 — sandbox staging", () => {
  it("copies the vault so a write to the copy leaves the original untouched", async () => {
    v = readOnlyVault({ "a.md": "original" });
    const sb = await stageSandbox(v.root, cacheDir as string);
    try {
      expect(readFileSync(join(sb.root, "a.md"), "utf8")).toBe("original");
      writeFileSync(join(sb.root, "a.md"), "changed in sandbox");
      // The point: the real vault is untouched.
      expect(v.read("a.md")).toBe("original");
    } finally {
      sb.dispose();
    }
  });

  // THE-739. The previous version of this test wrote the literal string "fake-db-bytes" to a file
  // named cache.db and asserted it came back — which proves cpSync ran, and nothing about whether a
  // SQLite database survives staging. That is the gap the ticket names, so this opens the staged
  // copy and reads a row committed just before staging.
  it("stages a REAL database as a consistent snapshot, including uncheckpointed WAL writes", async () => {
    v = readOnlyVault({ "a.md": "x" });
    const src = join(cacheDir as string, "cache.db");
    const live = await openDatabase(src);
    live.exec("CREATE TABLE t (k TEXT PRIMARY KEY, val TEXT)");
    live.prepare("INSERT INTO t VALUES ('before-staging','present')").run();
    // The connection stays OPEN across staging — this is the production shape (`serve` holds one),
    // and it is what leaves the write sitting in an uncheckpointed -wal that a file copy misses.
    const sb = await stageSandbox(v.root, cacheDir as string);
    try {
      expect(existsSync(join(sb.cacheDir, "cache.db"))).toBe(true);
      const staged = await openDatabase(join(sb.cacheDir, "cache.db"));
      try {
        const row = staged.prepare("SELECT val FROM t WHERE k = 'before-staging'").get() as
          | { val: string }
          | undefined;
        // Under the old cpSync this row was absent — the exact failure that surfaced as
        // `unknown session` on a session that had just ended.
        expect(row?.val).toBe("present");
      } finally {
        staged.close?.();
      }
      // And the snapshot is self-contained: no sidecars to keep in sync.
      expect(existsSync(join(sb.cacheDir, "cache.db-wal"))).toBe(false);
    } finally {
      live.close?.();
      sb.dispose();
    }
  });

  it("dispose removes the staged copy", async () => {
    v = readOnlyVault({ "a.md": "x" });
    const sb = await stageSandbox(v.root, cacheDir as string);
    const staged = sb.root;
    sb.dispose();
    expect(existsSync(staged)).toBe(false);
  });
});
