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
import { rerunSession, stageSandbox } from "../src/workspace/rerun";
import { exitCodeFor } from "../src/workspace/rerun-verdict";
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

    expect(out.records[0]?.replayed?.error_code).toBe("forbidden");
    // THE property — not the verdict string. `add_vault` declares no `vaultArg`, so the
    // vault-binding guard cannot see it; the scope gate is the only thing that stops it.
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

describe("THE-645 item 3 — sandbox staging", () => {
  it("copies the vault so a write to the copy leaves the original untouched", () => {
    v = readOnlyVault({ "a.md": "original" });
    const sb = stageSandbox(v.root, cacheDir as string);
    try {
      expect(readFileSync(join(sb.root, "a.md"), "utf8")).toBe("original");
      writeFileSync(join(sb.root, "a.md"), "changed in sandbox");
      // The point: the real vault is untouched.
      expect(v.read("a.md")).toBe("original");
    } finally {
      sb.dispose();
    }
  });

  it("copies cache.db when it exists — an empty index would diverge every search for the wrong reason", () => {
    v = readOnlyVault({ "a.md": "x" });
    writeFileSync(join(cacheDir as string, "cache.db"), "fake-db-bytes");
    const sb = stageSandbox(v.root, cacheDir as string);
    try {
      expect(existsSync(join(sb.cacheDir, "cache.db"))).toBe(true);
      expect(readFileSync(join(sb.cacheDir, "cache.db"), "utf8")).toBe("fake-db-bytes");
    } finally {
      sb.dispose();
    }
  });

  it("dispose removes the staged copy", () => {
    v = readOnlyVault({ "a.md": "x" });
    const sb = stageSandbox(v.root, cacheDir as string);
    const staged = sb.root;
    sb.dispose();
    expect(existsSync(staged)).toBe(false);
  });
});
