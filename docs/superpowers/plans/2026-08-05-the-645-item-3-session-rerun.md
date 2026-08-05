# Session Re-run (THE-645 item 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `obsidian-tc rerun <session-id>` CLI command that re-issues a recorded session's captured tool arguments against current vault state and reports which calls diverged.

**Architecture:** A pure verdict classifier decides, per trace record, whether re-issuing it is faithful; a runner reads the trace server-side and dispatches only the faithful ones through the same `ToolRegistry.dispatch` a live call takes. Mutation safety lives in neither — observe mode forces `readOnly` onto the resolved `ServerConfig` **before** the runtime is built, so the registry's wired `aclResolver` returns read-only ACLs and the existing `policy-gates.ts` gate refuses writes. A `--sandbox` flag copies the vault and its databases to a temp directory and runs with the unmodified config instead.

**Critical:** `aclResolver` is a `RegistryOptions` field (`mcp/registry/types.ts:257`, field at `:290`) fixed at `ToolRegistry` construction, and `dispatch.ts:197` → `input-binding.ts:88` **replaces** `ctx.acl` with its answer on every call naming a vault. Setting `ctx.acl` per call does not work and is not a matter of taste — a runner that tries it runs read-write while reporting `skipped_mutating: 0`.

**Tech Stack:** TypeScript 7.0.2, Bun 1.3.14, Vitest 4, Biome 2.5.x, `better-sqlite3`-style `Database` handle via `db/open`.

**Spec:** `docs/superpowers/specs/2026-08-05-the-645-item-3-session-rerun-design.md`

## Global Constraints

- **This adds NO MCP tool.** The eight-gate tool checklist in `CLAUDE.md` does **not** apply: no `REGISTERED_TOOL_COUNT` change, no facade domain map entry, no `boot.tools_registered` bump, no docgen marker regions, no `pathAcl`/`vaultArg` coverage entry, no m7 parity snapshot. Do not touch those files. If you find yourself editing `test/registered-tool-count.ts`, stop — you have added a tool by accident.
- **Biome enforces `noExcessiveLinesPerFile` at 700 lines.** Both new source files must stay well under it.
- **`check:boundaries` has a baseline of 0 circular imports.** `workspace/rerun.ts` may import from `workspace/sessions.ts` and `mcp/registry`; nothing in `mcp/` may import from `workspace/rerun.ts`.
- **`src` and `test` pin `types: ["node"]`.** Do not use Bun globals in either; this code is not in the `bun-smoke` project.
- **Run `bun run lint` at the REPO ROOT before every commit**, not `biome check --write` per file. The line-ceiling rule is invisible per-file.
- **Never pipe a test or gate through `tail`/`head`** — `$?` reports the pipe, not the command. Redirect to a log and check `$?` separately.
- **Commit with `git commit -s`** (DCO sign-off required).
- Do **not** run the full test suite locally; this box is 4 cores shared with ~43 containers. Targeted vitest only.

## File Structure

| file | responsibility |
|---|---|
| `packages/server/src/workspace/rerun-verdict.ts` (create) | Pure. Per-record verdict, run summary, exit code. No I/O, no dispatch. |
| `packages/server/src/workspace/rerun.ts` (create) | Session lookup, trace read, the dispatch loop, sandbox staging. |
| `packages/server/src/cli/commands/rerun.ts` (create) | CLI wrapper: `withReadOnlyAcl` (the safety guarantee), build runtime, call runner, render output, set exit code. |
| `packages/server/src/cli/args.ts` (modify) | `rerun` command kind + USAGE entry. |
| `packages/server/src/cli.ts` (modify) | Import + `switch` case. |
| `packages/server/test/session-rerun-verdict.test.ts` (create) | Classifier + summary + exit-code tests. Pure, fast. |
| `packages/server/test/session-rerun.test.ts` (create) | Runner integration, `withReadOnlyAcl`, sandbox staging, and the safety properties. |

The pure/impure split is deliberate: the classifier is the part with six branches and no dependencies, so it gets a test file that runs in milliseconds and needs no vault fixture.

---

### Task 1: Verdict classifier

**Files:**
- Create: `packages/server/src/workspace/rerun-verdict.ts`
- Test: `packages/server/test/session-rerun-verdict.test.ts`

**Interfaces:**
- Consumes: `TraceRecord` from `packages/server/src/workspace/sessions.ts:353`
- Produces: `RerunVerdict`, `ClassifiedRecord`, `classifyRecord(rec: TraceRecord): ClassifiedRecord`

- [ ] **Step 1: Write the failing test**

Create `packages/server/test/session-rerun-verdict.test.ts`:

```ts
// THE-645 item 3 — the verdict classifier. Pure: no vault, no dispatch, no I/O.
//
// Every non-`runnable` verdict is a way a "successful" re-run would be silently wrong, so the
// classifier is DEFAULT-DENY: a record that does not positively satisfy the capture contract is
// refused, never attempted.
import { describe, expect, it } from "vitest";
import type { TraceRecord } from "../src/workspace/sessions";
import { classifyRecord } from "../src/workspace/rerun-verdict";

const base: TraceRecord = { ts: 1000, type: "tool_invocation", tool: "read_note", status: "ok" };

describe("THE-645 item 3 — classifyRecord", () => {
  it("runnable only when args are present AND the scan says clean", () => {
    const out = classifyRecord({ ...base, args: '{"path":"a.md"}', args_scan: "clean" });
    expect(out.verdict).toBe("runnable");
    expect(out.args).toEqual({ path: "a.md" });
  });

  it("no_capture when the args field is ABSENT — distinct from empty args", () => {
    // The universal case while `sessions.traceContent` is off. Dispatching `{}` here would be a
    // valid-looking call that is wrong, so absent must not collapse into empty.
    const out = classifyRecord({ ...base, args_hash: "abc" });
    expect(out.verdict).toBe("no_capture");
    expect(out.args).toBeNull();
  });

  it("redacted — [REDACTED] is substituted INTO the argument text", () => {
    const out = classifyRecord({ ...base, args: '{"note":"[REDACTED]"}', args_scan: "redacted:1" });
    expect(out.verdict).toBe("redacted");
    expect(out.args).toBeNull();
  });

  it("truncated — JSON cut at the cap is not parseable and must not be repaired", () => {
    const out = classifyRecord({ ...base, args: '{"body":"xxx', args_scan: "truncated" });
    expect(out.verdict).toBe("truncated");
    expect(out.args).toBeNull();
  });

  it("unparseable when JSON.parse throws on a line readTrace let through", () => {
    const out = classifyRecord({ ...base, args: "{not json", args_scan: "clean" });
    expect(out.verdict).toBe("unparseable");
    expect(out.args).toBeNull();
  });

  it("refuses args present with NO args_scan — the contract is unsatisfied, not merely unusual", () => {
    // captureArgs always writes both fields together. One without the other is a record this
    // classifier cannot vouch for, and default-deny is the safe direction.
    const out = classifyRecord({ ...base, args: '{"path":"a.md"}' });
    expect(out.verdict).toBe("unparseable");
  });

  it("refuses a non-object payload — dispatch takes a record, not a scalar", () => {
    const out = classifyRecord({ ...base, args: "42", args_scan: "clean" });
    expect(out.verdict).toBe("unparseable");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bunx vitest run test/session-rerun-verdict.test.ts`
Expected: FAIL — `Failed to resolve import "../src/workspace/rerun-verdict"`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/server/src/workspace/rerun-verdict.ts`:

```ts
// THE-645 item 3 — is re-issuing this recorded call FAITHFUL?
//
// Pure by design: six branches, no dependencies, so it is testable without a vault fixture.
//
// DEFAULT-DENY. Every verdict other than `runnable` is a way a re-run that reported success would
// have been silently wrong — writing `[REDACTED]` into a note, dispatching `{}` because the args
// field was absent, or "repairing" JSON that was cut mid-string. A record that does not positively
// satisfy the capture contract is refused.
import type { TraceRecord } from "./sessions";

export type RerunVerdict =
  | "runnable"
  | "no_capture"
  | "redacted"
  | "truncated"
  | "skipped_mutating"
  | "unparseable";

export interface ClassifiedRecord {
  verdict: RerunVerdict;
  /** The parsed arguments, ONLY for `runnable`. Null on every refusal — there is no partial
   *  credit, and a caller cannot accidentally dispatch a refused record's payload. */
  args: Record<string, unknown> | null;
  /** Operator-facing reason. Empty for `runnable`. */
  reason: string;
}

const REFUSE = (verdict: RerunVerdict, reason: string): ClassifiedRecord => ({
  verdict,
  args: null,
  reason,
});

/**
 * Classify ONE trace record. `skipped_mutating` is never produced here — that verdict is
 * dispatch's ruling under a read-only ACL, recorded after the fact, not a prediction this
 * function makes. See rerun.ts.
 */
export function classifyRecord(rec: TraceRecord): ClassifiedRecord {
  if (rec.args === undefined)
    return REFUSE(
      "no_capture",
      "no arguments were captured for this call — `sessions.traceContent` was off when the session was recorded",
    );
  if (rec.args_scan === "truncated")
    return REFUSE(
      "truncated",
      "arguments were cut at the capture size cap; the JSON is incomplete and repairing it would be invention",
    );
  if (typeof rec.args_scan === "string" && rec.args_scan.startsWith("redacted:"))
    return REFUSE(
      "redacted",
      `secrets were scrubbed from the arguments (${rec.args_scan}) — re-issuing would send the literal [REDACTED] placeholder`,
    );
  if (rec.args_scan !== "clean")
    return REFUSE(
      "unparseable",
      "record does not satisfy the capture contract: `args` present without `args_scan: clean`",
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(rec.args);
  } catch {
    return REFUSE("unparseable", "captured arguments are not valid JSON (torn or corrupt line)");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return REFUSE("unparseable", "captured arguments are not a JSON object");
  return { verdict: "runnable", args: parsed as Record<string, unknown>, reason: "" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && bunx vitest run test/session-rerun-verdict.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
cd ~/obsidian-tc
bun run lint
git add packages/server/src/workspace/rerun-verdict.ts packages/server/test/session-rerun-verdict.test.ts
git commit -s -m "feat(rerun): classify whether a trace record is faithfully re-issuable (THE-645 item 3)"
```

---

### Task 2: Run summary and exit codes

**Files:**
- Modify: `packages/server/src/workspace/rerun-verdict.ts` (append)
- Test: `packages/server/test/session-rerun-verdict.test.ts` (append)

**Interfaces:**
- Consumes: `RerunVerdict` from Task 1
- Produces: `RerunRecord`, `RerunSummary`, `summarize(records: RerunRecord[]): RerunSummary`, `exitCodeFor(summary: RerunSummary): 0 | 1 | 2`

- [ ] **Step 1: Write the failing test**

Append to `packages/server/test/session-rerun-verdict.test.ts`:

```ts
import { exitCodeFor, type RerunRecord, summarize } from "../src/workspace/rerun-verdict";

const rec = (over: Partial<RerunRecord>): RerunRecord => ({
  seq: 0,
  ts: 1000,
  tool: "read_note",
  caller: null,
  verdict: "runnable",
  reason: "",
  recorded: { status: "ok", result_size: 10, duration_ms: 1 },
  replayed: { status: "ok", result_size: 10, duration_ms: 1 },
  divergence: "none",
  ...over,
});

describe("THE-645 item 3 — summary and exit codes", () => {
  it("counts every verdict, including the ones that are zero", () => {
    const s = summarize([rec({}), rec({ seq: 1, verdict: "no_capture", replayed: null })]);
    expect(s.total).toBe(2);
    expect(s.runnable).toBe(1);
    expect(s.byVerdict.no_capture).toBe(1);
    expect(s.byVerdict.redacted).toBe(0);
    expect(s.diverged).toBe(0);
  });

  it("exit 0 — something ran and nothing moved", () => {
    expect(exitCodeFor(summarize([rec({})]))).toBe(0);
  });

  it("exit 1 — something ran and something moved", () => {
    const s = summarize([rec({}), rec({ seq: 1, divergence: "status" })]);
    expect(s.diverged).toBe(1);
    expect(exitCodeFor(s)).toBe(1);
  });

  it("exit 2 — NOTHING was runnable, which is not the same observable outcome as success", () => {
    // The vacuity guard. On a deployment with `sessions.traceContent` off this is the ONLY
    // reachable path, and without its own code it is indistinguishable from "everything passed".
    const s = summarize([
      rec({ verdict: "no_capture", replayed: null }),
      rec({ seq: 1, verdict: "no_capture", replayed: null }),
    ]);
    expect(s.runnable).toBe(0);
    expect(exitCodeFor(s)).toBe(2);
  });

  it("exit 2 on an EMPTY trace — zero records is also zero runnable", () => {
    expect(exitCodeFor(summarize([]))).toBe(2);
  });

  it("a run with BOTH refusals and divergence exits 1, not 2", () => {
    // Partial refusal is the expected steady state; only TOTAL refusal is what 2 carries.
    const s = summarize([
      rec({ divergence: "error_code" }),
      rec({ seq: 1, verdict: "redacted", replayed: null }),
    ]);
    expect(exitCodeFor(s)).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bunx vitest run test/session-rerun-verdict.test.ts`
Expected: FAIL — `summarize is not exported` / `exitCodeFor is not exported`.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/server/src/workspace/rerun-verdict.ts`:

```ts
/** What dispatch reported, on the recorded run and on this one. `Status` is
 *  `"ok" | "error" | "skipped"` (mcp/registry/types.ts:229). */
export interface CallOutcome {
  status?: string;
  result_size?: number;
  duration_ms?: number;
  error_code?: string;
}

export interface RerunRecord {
  seq: number;
  ts: number;
  tool: string;
  caller: string | null;
  verdict: RerunVerdict;
  reason: string;
  recorded: CallOutcome;
  /** Null for every verdict except `runnable` — a refused record was never dispatched. */
  replayed: CallOutcome | null;
  divergence: "none" | "status" | "error_code";
}

export interface RerunSummary {
  total: number;
  runnable: number;
  diverged: number;
  byVerdict: Record<RerunVerdict, number>;
}

const ZERO: Record<RerunVerdict, number> = {
  runnable: 0,
  no_capture: 0,
  redacted: 0,
  truncated: 0,
  skipped_mutating: 0,
  unparseable: 0,
};

export function summarize(records: RerunRecord[]): RerunSummary {
  const byVerdict = { ...ZERO };
  let diverged = 0;
  for (const r of records) {
    byVerdict[r.verdict] += 1;
    if (r.divergence !== "none") diverged += 1;
  }
  return { total: records.length, runnable: byVerdict.runnable, diverged, byVerdict };
}

/**
 * 0 = ran, nothing moved. 1 = ran, something moved (the regression signal). 2 = NOTHING was
 * runnable.
 *
 * 2 existing at all is the point. The happy path and the total-refusal path both terminate without
 * errors, so without a distinct code "everything was refused" and "everything passed" are the same
 * observable outcome — and while `sessions.traceContent` is off, total refusal is the only
 * reachable path. Conditions are disjoint and evaluated in this order.
 */
export function exitCodeFor(summary: RerunSummary): 0 | 1 | 2 {
  if (summary.runnable === 0) return 2;
  if (summary.diverged > 0) return 1;
  return 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && bunx vitest run test/session-rerun-verdict.test.ts`
Expected: PASS, 13 tests total.

- [ ] **Step 5: Commit**

```bash
cd ~/obsidian-tc
bun run lint
git add packages/server/src/workspace/rerun-verdict.ts packages/server/test/session-rerun-verdict.test.ts
git commit -s -m "feat(rerun): run summary and the exit code that makes total refusal visible (THE-645 item 3)"
```

---

### Task 3: The runner, in observe mode

This is the task that carries the safety guarantee. Steps 5–8 are the mutation cycle and are **not** optional.

**Files:**
- Create: `packages/server/src/workspace/rerun.ts`
- Test: `packages/server/test/session-rerun.test.ts`

**Interfaces:**
- Consumes: `classifyRecord`, `RerunRecord`, `summarize` (Tasks 1–2); `getSession` (`workspace/sessions.ts:314`), `resolveTraceAbs` (`:86`), `readTrace` (`:391`); `ToolRegistry.dispatch` (`mcp/registry`)
- Produces: `rerunSession(opts: RerunOptions): Promise<RerunResult>` where `RerunResult = { records: RerunRecord[]; summary: RerunSummary }`

- [ ] **Step 1: Write the failing test**

Create `packages/server/test/session-rerun.test.ts`:

```ts
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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rerunSession } from "../src/workspace/rerun";
import { appendTrace, insertSession } from "../src/workspace/sessions";
import { makeTestVault, type TestVault } from "./m1-helpers";

let v: TestVault | undefined;
let cacheDir: string | undefined;
afterEach(() => {
  v?.cleanup();
  if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
  cacheDir = undefined;
});

/** A vault whose ACL is read-only unless `writable` — the mutation in Step 5 flips this. */
function readOnlyVault(files: Record<string, string>, writable = false): TestVault {
  cacheDir = mkdtempSync(join(tmpdir(), "obtc-rerun-cache-"));
  return makeTestVault({ files, acl: { readOnly: !writable } });
}

/** Open a session row and write `records` into its trace file. Returns the session id. */
function seedSession(vault: TestVault, records: Array<Record<string, unknown>>): string {
  const id = `sess_rerun_${records.length}`;
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

    const out = await rerunSession({ db: v.db, registry: v.registry, sessionId: id, cacheDir: cacheDir as string });

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
        args: JSON.stringify({ vault: v.id, path: "a.md", content: "OVERWRITTEN" }),
        args_scan: "clean",
      },
    ]);

    await rerunSession({ db: v.db, registry: v.registry, sessionId: id, cacheDir: cacheDir as string });

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
        args: JSON.stringify({ vault: v.id, path: "a.md", content: "OVERWRITTEN" }),
        args_scan: "clean",
      },
    ]);
    const out = await rerunSession({ db: v.db, registry: v.registry, sessionId: id, cacheDir: cacheDir as string });
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

    const out = await rerunSession({ db: v.db, registry: spied, sessionId: id, cacheDir: cacheDir as string });
    expect(out.records[0]?.verdict).toBe("redacted");
    expect(seen).toEqual([]);
  });

  it("an unknown session id is an error, not an empty successful run", async () => {
    v = readOnlyVault({});
    await expect(
      rerunSession({ db: v.db, registry: v.registry, sessionId: "nope", cacheDir: cacheDir as string }),
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
        expectVaultId: "some-other-vault",
      }),
    ).rejects.toThrow(/belongs to vault/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bunx vitest run test/session-rerun.test.ts`
Expected: FAIL — `Failed to resolve import "../src/workspace/rerun"`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/server/src/workspace/rerun.ts`:

```ts
// THE-645 item 3 — re-issue a recorded session's captured arguments against current vault state.
//
// RE-EXECUTION, not reconstruction. The prevailing meaning of "replay" in agent tooling is to walk
// the control flow again substituting STORED RESULTS, so nothing executes. That is impossible here
// and not by oversight: THE-736 captured arguments and deliberately not results. So the only
// available shape is to re-issue the inputs and compare what comes back — which is also what the
// ticket asks for. Hence `rerun`, not `replay`.
//
// MUTATION SAFETY IS NOT IMPLEMENTED HERE. Observe mode hands dispatch a read-only ACL and the
// existing gate at mcp/registry/policy-gates.ts:132-135 refuses every mutating call, using the same
// `isMutating` predicate the facade and visibility layers use. A runner-side "is this tool
// mutating" list would be a SECOND copy of that rule, and the two can disagree — which is how a
// re-run eventually executes a write it believed was a read.
import type { Database } from "../db/open";
import type { ToolRegistry } from "../mcp/registry";
import {
  classifyRecord,
  type RerunRecord,
  type RerunSummary,
  summarize,
} from "./rerun-verdict";
import { getSession, readTrace, resolveTraceAbs } from "./sessions";

export interface RerunOptions {
  db: Database;
  registry: ToolRegistry;
  sessionId: string;
  cacheDir: string;
  /** Present only for `--sandbox`; observe mode never needs a vault root. */
  vaultRoot?: string;
  /** Reporting only — the runner enforces nothing. Observe mode's read-only ACL is applied to the
   *  CONFIG before the registry is built; by the time a call reaches here the decision is made. */
  sandbox?: boolean;
  /** `--vault`. Checked against the session row and thrown on mismatch — the flag exists to fail
   *  loudly rather than let an operator re-run against a vault they did not mean. */
  expectVaultId?: string;
}

export interface RerunResult {
  records: RerunRecord[];
  summary: RerunSummary;
}

/** A dispatch result, narrowed to what a re-run compares. */
interface DispatchLike {
  ok: boolean;
  data?: unknown;
  error?: { code?: string };
}

export async function rerunSession(opts: RerunOptions): Promise<RerunResult> {
  const row = getSession(opts.db, opts.sessionId);
  // An unknown id must throw. Returning an empty successful run would report "0 calls, all fine"
  // for a session that does not exist — a failure encoded as a valid result.
  if (!row) throw new Error(`unknown session: ${opts.sessionId}`);
  // `--vault` is a guard, not a selector: the row already knows its vault. A mismatch means the
  // operator believes they are re-running something they are not.
  if (opts.expectVaultId !== undefined && opts.expectVaultId !== row.vault_id)
    throw new Error(
      `session ${opts.sessionId} belongs to vault ${row.vault_id}, not ${opts.expectVaultId}`,
    );

  const abs = resolveTraceAbs({
    store: row.trace_store,
    tracePath: row.trace_path,
    cacheDir: opts.cacheDir,
    vaultRoot: opts.vaultRoot ?? "",
  });

  const invocations = readTrace(abs)
    .filter((r) => r.type === "tool_invocation" && typeof r.tool === "string")
    .sort((a, b) => a.ts - b.ts);

  const records: RerunRecord[] = [];
  for (const [seq, rec] of invocations.entries()) {
    const classified = classifyRecord(rec);
    const recorded = {
      status: rec.status as string | undefined,
      result_size: rec.result_size,
      duration_ms: rec.duration_ms,
      ...(rec.error_code ? { error_code: rec.error_code as string } : {}),
    };
    const common = {
      seq,
      ts: rec.ts,
      tool: rec.tool as string,
      caller: (rec.caller as string | null) ?? null,
      recorded,
    };

    if (classified.verdict !== "runnable" || classified.args === null) {
      records.push({
        ...common,
        verdict: classified.verdict,
        reason: classified.reason,
        replayed: null,
        divergence: "none",
      });
      continue;
    }

    const started = Date.now();
    const res = (await opts.registry.dispatch(common.tool, classified.args, {
      caller: row.caller,
      authenticated: true,
      grantedScopes: new Set(["read:notes", "read:workspace"]),
      vaultId: row.vault_id,
      db: opts.db,
      // NO ACL LOGIC HERE, deliberately. Observe mode's read-only-ness is applied to the resolved
      // ServerConfig before the runtime is built (see `withReadOnlyAcl` in cli/commands/rerun.ts),
      // so the registry's own `aclResolver` returns read-only ACLs by construction.
      //
      // Setting `ctx.acl` here would NOT work: `aclResolver` is a RegistryOptions field
      // (mcp/registry/types.ts:257, field at :290), fixed at ToolRegistry construction, and
      // dispatch.ts:197 -> input-binding.ts:88 REPLACES ctx.acl with the resolver's answer on every
      // call that names a vault. A per-call override is overwritten before the gate reads it.
    } as never)) as DispatchLike;

    const code = res.error?.code;
    // Dispatch refuses a mutating call under a read-only ACL with `forbidden`. That is the gate's
    // ruling, recorded — not a prediction this runner made.
    if (!opts.sandbox && !res.ok && code === "forbidden") {
      records.push({
        ...common,
        verdict: "skipped_mutating",
        reason: "mutating call refused by the read-only ACL (observe mode)",
        replayed: null,
        divergence: "none",
      });
      continue;
    }

    const replayed = {
      status: res.ok ? "ok" : "error",
      result_size: JSON.stringify(res.data ?? null).length,
      duration_ms: Date.now() - started,
      ...(code ? { error_code: code } : {}),
    };
    // Deliberately narrow. `result_size` is REPORTED but never asserted: a note legitimately
    // edited since recording changes byte counts, so failing on size produces failures that mean
    // nothing and train the reader to ignore the report.
    const divergence =
      replayed.status !== (recorded.status ?? "ok")
        ? "status"
        : (recorded.error_code ?? "") !== (code ?? "")
          ? "error_code"
          : "none";

    records.push({
      ...common,
      verdict: "runnable",
      reason: "",
      replayed,
      divergence,
    });
  }

  return { records, summary: summarize(records) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && bunx vitest run test/session-rerun.test.ts`
Expected: PASS, 6 tests.

If `resolveTraceAbs`'s parameter names differ from the call above, read `packages/server/src/workspace/sessions.ts:80-95` and match the real signature — do not reshape the function.

- [ ] **Step 5: Mutation — remove the guard**

In `packages/server/test/session-rerun.test.ts`, make the fixture writable — this is what a missing
or ineffective read-only ACL looks like from the runner's side:

```ts
function readOnlyVault(files: Record<string, string>, writable = true): TestVault {
```

(default flipped `false` -> `true`)

- [ ] **Step 6: Run the test and confirm it goes RED for the right reason**

Run: `cd packages/server && bunx vitest run test/session-rerun.test.ts`
Expected: FAIL on **"DOES NOT WRITE in observe mode"** with `expected 'OVERWRITTEN' to be 'original'`.

The failure direction matters. If it instead fails only on the verdict-string test, the safety test
is not asserting the effect and must be fixed before proceeding. If NOTHING goes red, stop: it means
`patch_note` never executed even with a writable ACL — most likely it is not registered in the
fixture — and the guarantee is unproven rather than proven. Confirm `makeTestVault` (not
`makeM5Vault`) is in use.

- [ ] **Step 7: Restore the guard**

Edit the default back to `writable = false` — **by editing it back**, not with `git checkout --`,
which reverts the file to HEAD and would destroy the rest of this task's uncommitted work.

- [ ] **Step 8: Re-run and confirm green**

Run: `cd packages/server && bunx vitest run test/session-rerun.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 9: Commit**

```bash
cd ~/obsidian-tc
bun run lint
git add packages/server/src/workspace/rerun.ts packages/server/test/session-rerun.test.ts
git commit -s -m "feat(rerun): re-issue a recorded session under a read-only ACL (THE-645 item 3)

Observe mode is ctx.acl.readOnly, not a runner-side classifier: policy-gates.ts
already refuses mutating calls using the same isMutating predicate the facade and
visibility layers use. aclResolver is deliberately not wired -- dispatch SWAPS
ctx.acl per vault, which would silently turn observe mode read-write.

The no-write test asserts the note on disk, and was watched failing with the
guard removed."
```

---

### Task 4: CLI command

**Files:**
- Create: `packages/server/src/cli/commands/rerun.ts`
- Modify: `packages/server/src/cli/args.ts`
- Modify: `packages/server/src/cli.ts`

**Interfaces:**
- Consumes: `rerunSession` (Task 3), `exitCodeFor` (Task 2), `Cmd<"rerun">` and `resolveOrUsageExit` from `cli/shared.ts`
- Produces: `run_rerun(cmd: Cmd<"rerun">): Promise<void>`

- [ ] **Step 1: Add the command kind to the arg parser**

In `packages/server/src/cli/args.ts`, add to the `parseCliArgs` return union (beside the other command kinds, e.g. after the `prefetch` entry at line ~45):

```ts
  | { kind: "rerun"; input?: string; sessionId: string; vault?: string; sandbox?: boolean; json?: boolean }
```

Add the parse branch beside `prefetch`'s (`cli/args.ts:585`), copying its idiom exactly: an
`if (first === ...)` block, `flagValue(rest, "--x")` for valued flags, `rest.includes("--x")` for
booleans, and a `scan` copy with flag pairs spliced out so the positional can be found. **Errors
return `{ kind: "error", message }` — the parser never calls `process.exit`; `run_error` renders it.**

```ts
    // THE-645 item 3: re-issue a recorded session's captured arguments.
    if (first === "rerun") {
      const scan = [...rest];
      for (const f of ["--vault", "--config"]) {
        const i = scan.indexOf(f);
        if (i >= 0) scan.splice(i, 2);
      }
      const sessionId = scan.find((a) => !a.startsWith("-"));
      if (sessionId === undefined)
        return { kind: "error", message: "rerun requires a session id" };
      return {
        kind: "rerun",
        sessionId,
        ...(flagValue(rest, "--config") !== undefined
          ? { input: flagValue(rest, "--config") }
          : {}),
        ...(flagValue(rest, "--vault") !== undefined ? { vault: flagValue(rest, "--vault") } : {}),
        ...(rest.includes("--sandbox") ? { sandbox: true } : {}),
        ...(rest.includes("--json") ? { json: true } : {}),
      };
    }
```

`flagValue` (`cli/args.ts:173`) throws `CliError` when a flag is present with no value, so a bare
`--vault` is already handled — do not add a second check for it.

- [ ] **Step 2: Add the USAGE entry**

In the `USAGE` template literal in `packages/server/src/cli/args.ts`, beside the other command entries:

```
  obsidian-tc rerun <session-id> [path] [--vault <id>] [--sandbox] [--json]
                                        Re-issue a recorded session's captured tool arguments
                                        against current vault state and report which calls
                                        diverged (THE-645 item 3). RE-EXECUTION, not stubbed
                                        replay: results were never captured, so there is nothing
                                        to substitute. Requires `sessions.traceContent` to have
                                        been ON when the session was recorded; otherwise every
                                        record is refused and the command exits 2.
                                        Default mode refuses every mutating call via a read-only
                                        ACL. --sandbox copies the vault and its databases to a
                                        temp dir and runs everything for real against the copy.
                                        Exit: 0 nothing moved, 1 divergence found, 2 nothing
                                        was runnable.
```

- [ ] **Step 3: Write the command**

Create `packages/server/src/cli/commands/rerun.ts`:

```ts
import { join } from "node:path";
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { openDatabase } from "../../db/open";
import { buildServerRuntime } from "../../runtime/server-runtime";
import { rerunSession } from "../../workspace/rerun";
import { exitCodeFor } from "../../workspace/rerun-verdict";
import { type Cmd, resolveOrUsageExit } from "../shared";

/**
 * Observe mode's ENTIRE safety guarantee.
 *
 * `aclResolver` is a RegistryOptions field fixed at ToolRegistry construction
 * (mcp/registry/types.ts:257, field at :290), and dispatch.ts:197 -> input-binding.ts:88 REPLACES
 * ctx.acl with its answer on every call that names a vault. So a per-call `ctx.acl` override is
 * overwritten before the readOnly gate reads it, and the only place the decision survives is the
 * config the resolver is built from.
 *
 * Forcing the root alone is NOT enough: a vault carrying its own `acl` block overrides the root, so
 * exactly those vaults would stay writable while the run reported a clean observe-mode pass.
 */
export function withReadOnlyAcl(cfg: ServerConfig): ServerConfig {
  return {
    ...cfg,
    acl: { ...cfg.acl, readOnly: true },
    vaults: cfg.vaults.map((v) => (v.acl ? { ...v, acl: { ...v.acl, readOnly: true } } : v)),
  };
}

export async function run_rerun(cmd: Cmd<"rerun">): Promise<void> {
  // Observe mode (the default) forces read-only BEFORE the runtime exists. --sandbox keeps the
  // real config, because everything it touches is a disposable copy.
  const cfg = cmd.sandbox ? resolveOrUsageExit(cmd.input) : withReadOnlyAcl(resolveOrUsageExit(cmd.input));
  // buildServerRuntime, but never start(): a re-run needs the FULLY wired registry (every tool
  // family, not just m7 the way prefetch does) and none of the transports. close() unwinds
  // whatever the build brought up.
  const runtime = await buildServerRuntime(cfg, cmd.input);
  // Opened here rather than reached for through the runtime, mirroring prefetch.ts:16-17.
  // `ServerRuntime` exposes `registry`, `start` and `close` only (server-runtime.ts:72-76) — do
  // not add a field to it for this.
  const db = await openDatabase(join(cfg.cacheDir, "cache.db"));
  try {
    const result = await rerunSession({
      db,
      registry: runtime.registry,
      sessionId: cmd.sessionId,
      cacheDir: cfg.cacheDir,
      ...(cmd.vault !== undefined ? { expectVaultId: cmd.vault } : {}),
      ...(cmd.sandbox ? { sandbox: true } : {}),
    });

    if (cmd.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      for (const r of result.records) {
        const line =
          r.verdict === "runnable"
            ? `${r.seq}\t${r.tool}\t${r.divergence === "none" ? "same" : `DIVERGED (${r.divergence})`}\trecorded=${r.recorded.status} replayed=${r.replayed?.status} size ${r.recorded.result_size}->${r.replayed?.result_size}`
            : `${r.seq}\t${r.tool}\t${r.verdict.toUpperCase()}\t${r.reason}`;
        process.stdout.write(`${line}\n`);
      }
      const s = result.summary;
      // runnable LEADS the summary, so "nothing ran" cannot be skimmed past.
      process.stdout.write(
        `\nrunnable ${s.runnable}/${s.total} · diverged ${s.diverged} · ` +
          `no_capture ${s.byVerdict.no_capture} · redacted ${s.byVerdict.redacted} · ` +
          `truncated ${s.byVerdict.truncated} · skipped_mutating ${s.byVerdict.skipped_mutating} · ` +
          `unparseable ${s.byVerdict.unparseable}\n`,
      );
      if (s.runnable === 0)
        process.stderr.write(
          "rerun: nothing was runnable. If every record reads `no_capture`, `sessions.traceContent` was off when this session was recorded — the trace holds no arguments to re-issue.\n",
        );
    }
    process.exitCode = exitCodeFor(result.summary);
  } finally {
    db.close?.();
    await runtime.close("rerun complete");
  }
}
```

`rerunSession` throws on an unknown session id and on a `--vault` mismatch. Both propagate to
`cli.ts`'s top-level `main().catch(...)`, which writes `fatal: <message>` and exits `1` — the
existing behaviour for every other command, so do not add a local try/catch that would swallow them
into a misleading exit code.

- [ ] **Step 4: Register the command**

In `packages/server/src/cli.ts`, add the import beside the others (alphabetical, after `run_reflect`):

```ts
import { run_rerun } from "./cli/commands/rerun";
```

and the switch case beside the others in `main()`:

```ts
    case "rerun":
      return run_rerun(cmd);
```

- [ ] **Step 5: Test `withReadOnlyAcl` — the per-vault override is the case that matters**

Append to `packages/server/test/session-rerun.test.ts`:

```ts
import { withReadOnlyAcl } from "../src/cli/commands/rerun";

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
    expect((cfg as { acl: { readOnly: boolean } }).acl.readOnly).toBe(false);
  });
});
```

Run: `cd packages/server && bunx vitest run test/session-rerun.test.ts`
Expected: PASS. If `ServerConfig`'s vault entry names its ACL field something other than `acl`, or its
root field something other than `root`, read `packages/shared/src/config/auth-acl.schema.ts` and the
vault schema and use the real names — do not add fields.

- [ ] **Step 6: Verify the command is reachable and exits 2 on a dark trace**

Run:

```bash
cd ~/obsidian-tc/packages/server
bun run src/cli.ts rerun --help > /tmp/rerun-help.log 2>&1; echo "exit=$?"
grep -c 'rerun <session-id>' /tmp/rerun-help.log
```

Expected: the USAGE text contains the `rerun` entry. (Check `$?` separately from any pipe — a pipeline reports the pipe's status, not the command's.)

- [ ] **Step 7: Typecheck and lint**

```bash
cd ~/obsidian-tc
bun run typecheck > /tmp/tc.log 2>&1; echo "typecheck exit=$?"
bun run lint > /tmp/lint.log 2>&1; echo "lint exit=$?"
```

Expected: both `0`. `bun run lint` must be run at the repo root.

- [ ] **Step 8: Commit**

```bash
cd ~/obsidian-tc
git add packages/server/src/cli/commands/rerun.ts packages/server/src/cli/args.ts packages/server/src/cli.ts packages/server/test/session-rerun.test.ts
git commit -s -m "feat(cli): obsidian-tc rerun <session-id> (THE-645 item 3)

Leads the summary with runnable N/total and writes an explicit note to stderr
when nothing was runnable, naming sessions.traceContent -- otherwise 0 of N
reads as a broken runner rather than as capture having been off."
```

---

### Task 5: Sandbox mode

**Files:**
- Modify: `packages/server/src/workspace/rerun.ts`
- Test: `packages/server/test/session-rerun.test.ts` (append)

**Interfaces:**
- Consumes: `RerunOptions.sandbox`, `RerunOptions.vaultRoot` (Task 3)
- Produces: `stageSandbox(vaultRoot: string, cacheDir: string): { root: string; cacheDir: string; dispose(): void }`

- [ ] **Step 1: Write the failing test**

Append to `packages/server/test/session-rerun.test.ts`:

```ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { stageSandbox } from "../src/workspace/rerun";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bunx vitest run test/session-rerun.test.ts`
Expected: FAIL — `stageSandbox is not exported`.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/server/src/workspace/rerun.ts`:

```ts
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Databases copied alongside the vault. Without them the sandbox index is EMPTY and every search
 *  diverges for a reason unrelated to the change being investigated. */
const SANDBOX_DBS = ["cache.db", "experiential.db"] as const;

/**
 * Stage a disposable copy of a vault and its databases.
 *
 * COPY, never symlink — a symlinked database is the live one, and the whole guarantee of sandbox
 * mode is that everything it touches is throwaway.
 */
export function stageSandbox(
  vaultRoot: string,
  cacheDir: string,
): { root: string; cacheDir: string; dispose(): void } {
  const base = mkdtempSync(join(tmpdir(), "obtc-rerun-"));
  const root = join(base, "vault");
  const cache = join(base, "cache");
  cpSync(vaultRoot, root, { recursive: true, dereference: true });
  for (const name of SANDBOX_DBS) {
    const src = join(cacheDir, name);
    if (existsSync(src)) cpSync(src, join(cache, name), { dereference: true });
  }
  return {
    root,
    cacheDir: cache,
    dispose: () => rmSync(base, { recursive: true, force: true }),
  };
}
```

Move the `node:fs` / `node:os` / `node:path` imports to the top of the file with the others — Biome's import ordering will fail otherwise.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && bunx vitest run test/session-rerun.test.ts`
Expected: PASS, 13 tests in this file (6 runner + 4 withReadOnlyAcl + 3 sandbox).

- [ ] **Step 5: Wire `--sandbox` into the CLI command**

In `packages/server/src/cli/commands/rerun.ts`, resolve the vault root from config, stage before the
run, and dispose in the `finally`. Add above `run_rerun`:

```ts
/** The configured root for `vaultId`, or the first vault when none was named. Mirrors
 *  prefetch.ts:35-38: an unknown id exits 2 rather than silently falling back to a vault the
 *  operator did not name. */
function vaultRootFor(cfg: ServerConfig, vaultId: string | undefined): string {
  const v = vaultId === undefined ? cfg.vaults[0] : cfg.vaults.find((x) => x.id === vaultId);
  if (!v) {
    process.stderr.write(`rerun: unknown vault ${vaultId}\n`);
    process.exit(2);
  }
  return v.root;
}
```

with `import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";` at the top. Then in
`run_rerun`:

```ts
  const staged = cmd.sandbox ? stageSandbox(vaultRootFor(cfg, cmd.vault), cfg.cacheDir) : undefined;
```

Pass `staged.root` as `vaultRoot` and `staged.cacheDir` as `cacheDir` to `rerunSession` when staged,
and call `staged?.dispose()` in the `finally` **before** `runtime.close`. If `ServerConfig`'s vault
entry names its filesystem root something other than `root`, read the type in
`packages/shared/src/config/` and use the real field — do not add one.

- [ ] **Step 6: Typecheck, lint, and re-run both test files**

```bash
cd ~/obsidian-tc
bun run typecheck > /tmp/tc.log 2>&1; echo "typecheck exit=$?"
bun run lint > /tmp/lint.log 2>&1; echo "lint exit=$?"
cd packages/server
bunx vitest run test/session-rerun-verdict.test.ts test/session-rerun.test.ts > /tmp/rerun-tests.log 2>&1; echo "tests exit=$?"
```

Expected: all three `0`; 26 tests total (13 verdict + 13 runner/config/sandbox).

- [ ] **Step 7: Commit**

```bash
cd ~/obsidian-tc
git add packages/server/src/workspace/rerun.ts packages/server/src/cli/commands/rerun.ts packages/server/test/session-rerun.test.ts
git commit -s -m "feat(rerun): --sandbox stages a disposable vault + DB copy (THE-645 item 3)

Copies cache.db and experiential.db alongside the vault: without them the
sandbox index is empty and every search diverges for a reason unrelated to
the change under investigation. Copy, never symlink."
```

- [ ] **Step 8: Run the full server suite on CI, not here**

```bash
cd ~/obsidian-tc
git push -u origin mislam2/the-645-item-3-session-rerun
gh workflow run ci-server.yml --ref mislam2/the-645-item-3-session-rerun
```

This box is 4 cores shared with ~43 containers; GitHub-hosted runners are free for this repo and cover three OSes. Before opening the PR, use the **`gates`** skill to enumerate the real gate list from the workflows rather than from memory.

---

## Notes for the implementer

**`sessions.traceContent` stays OFF.** This work consumes the capture; it does not enable it. Flipping that flag is an operator decision still gated on the THE-238 red-team. Every test above seeds its own trace records directly with `appendTrace`, which is why the suite passes on a deployment where capture is dark.

**Do not add a `--allow-degraded` flag.** `redacted` and `truncated` are hard refusals by decision. An override would be reached for exactly when someone is under time pressure, which is when re-issuing a call carrying a `[REDACTED]` placeholder does the most damage.

**`TREE.md` will need regenerating** once these files land, and it collides on every merge because its line census derives from `git ls-files`. The order is: `git add` FIRST, then `bun run map`, then commit — and re-derive after every `git merge main`.
