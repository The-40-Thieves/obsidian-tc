// WP4.0: pin the ORDER runDispatch's pipeline stages run in, not just their outcomes.
// dispatch-parity, acl-fail-closed, dispatch-guards and the whole idempotency suite assert what a
// call RETURNS; none of them assert the SEQUENCE the stages run in. Dropping or reordering a
// stage is an authz bypass every one of those existing tests still passes.
//
// Each scenario below builds a registry wired with a trace-recording double on every seam
// runDispatch actually calls through — RegistryOptions.aclResolver / vaultKindResolver /
// rateLimiter.check / verifyElicit / rootResolver / onProfile / onEpisode, and
// ToolDefinition.inputSchema / precheck / pathAcl / handler / outputSchema — and asserts the
// ordered sequence those doubles fired in, not just the terminal outcome. The SAME wiring is used
// for every scenario, so a scenario's "downstream seams never fired" claim is a real absence, not
// an artifact of that one test not bothering to wire them.
//
// What this gate does NOT cover (do not read it as a general dispatch stage-drop/reorder gate):
//   - Three authorization gates (the `authenticated` check, `assertScopesGranted`, the
//     vault-binding guard) have no callback of their own — they are bracketed below by asserting
//     the OBSERVABLE prefix that ran and that `acl_resolver` (the very next observable seam)
//     never fired, not by a dedicated trace label.
//   - The tool lookup + disabled check, all three checkAborted() boundary checks, the idempotency
//     claim/read/finalize (a raw ctx.db write, not a seam), and the durable markEffectCommitted
//     write are likewise unobserved directly — only their outcomes are exercised.
//   - The REAL enforcePathAcl call (as opposed to the traced pathAcl extractor that feeds it) is
//     production code, not a double — a reorder inside it would not show up here.
//   - The audit DB write (writeEvent) is a different thing from the "episode" label below, which
//     traces onEpisode (the experiential-capture sink), not the audit table write.
//   - JSON serialization and the byte-length computation that feeds the overflow check are not
//     observed directly, only their outcome (the `overflow` error code).
// This is a strong regression gate for reordering/dropping stages that sit BETWEEN two observable
// seams; it is not a complete stage-order gate for the stages listed above.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResult, VaultKind } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { RateLimiter } from "../src/throttle";
import type { AclOp } from "../src/vault/acl-path";
import { openMemoryDb } from "./helpers";

function freshDb(): Database {
  const db = openMemoryDb();
  provisionCacheDb(db);
  return db;
}

function baseCtx(db: Database, over: Partial<CallerContext> = {}): CallerContext {
  return {
    caller: "t",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: "v1",
    db,
    ...over,
  };
}

/** Wraps a Zod schema so every `.safeParse` call pushes `label` onto `trace` before delegating —
 *  the only way to observe stage 3 (input validation) without touching production code. */
function tracedSchema<T>(schema: z.ZodType<T>, trace: string[], label: string): z.ZodType<T> {
  return {
    safeParse: (data: unknown) => {
      trace.push(label);
      return schema.safeParse(data);
    },
  } as unknown as z.ZodType<T>;
}

/** RateLimiter has private fields, so a plain object double can't satisfy RegistryOptions'
 *  `rateLimiter?: RateLimiter`. Subclassing is the only way to intercept `.check` and still
 *  type-check. */
class TracingRateLimiter extends RateLimiter {
  constructor(
    private readonly trace: string[],
    private readonly allow: boolean,
  ) {
    super();
  }
  override check(_callerHashValue: string, scopeClass: string, _vaultId: string, _nowMs: number) {
    this.trace.push("rate_limiter");
    return this.allow
      ? { ok: true, scopeClass, retryAfterSeconds: 0, currentBurst: -1, currentRate: -1 }
      : { ok: false, scopeClass, retryAfterSeconds: 1, currentBurst: 0, currentRate: 0 };
  }
}

interface BuildOverrides {
  destructive?: boolean;
  requiredScopes?: string[];
  grantedScopes?: Set<string>;
  vaultField?: string;
  aclReturn?: FolderAcl;
  pathAclRoot?: string;
  pathAclEntries?: ReadonlyArray<{ op: AclOp; path: string }>;
  outputSchema?: z.ZodType<unknown>;
  handlerReturn?: (input: any, ctx: CallerContext) => unknown;
  handlerThrow?: Error;
  rateOk?: boolean;
  hitlOk?: boolean;
  maxResponseBytes?: number;
  afterPrecheck?: () => void;
}

/** Builds one registry + one tool, with every seam runDispatch calls through wired to push its
 *  own stage label into `trace` before delegating to real behavior. Reused, identically, across
 *  every scenario below — so a scenario's expected trace is a genuine "this seam did/did not
 *  fire" claim against a pipeline that COULD have called it, not a consequence of that scenario
 *  simply not wiring it. Returns `db` so callers can close it (node:sqlite connections are not
 *  garbage-collected). */
function build(trace: string[], overrides: BuildOverrides = {}) {
  const db = freshDb();
  const calls = { handler: 0 };

  const registry = new ToolRegistry({
    rateLimiter: new TracingRateLimiter(trace, overrides.rateOk ?? true),
    verifyElicit: (token) => {
      trace.push("verify_elicit");
      return (overrides.hitlOk ?? true) && token === "valid";
    },
    aclResolver: () => {
      trace.push("acl_resolver");
      return overrides.aclReturn;
    },
    vaultKindResolver: (): VaultKind => {
      trace.push("vault_kind_resolver");
      return "private";
    },
    rootResolver: () => {
      trace.push("root_resolver");
      return overrides.pathAclRoot ?? "/wp4-dummy-root";
    },
    onProfile: () => trace.push("profile"),
    // THE ONLY terminal-outcome seam: onEpisode fires once per dispatch (success or error), so
    // "episode" is the last label in every scenario's trace. It observes onEpisode (the
    // experiential-capture sink), NOT the audit DB write (writeEvent) — those are two different
    // fail-open sinks recordOutcome calls, and only this one is injectable.
    onEpisode: () => trace.push("episode"),
    maxResponseBytes: overrides.maxResponseBytes,
  });

  registry.register({
    name: "tool",
    description: "WP4.0 gate-trace fixture",
    inputSchema: tracedSchema(
      z
        .object({
          vault: z.string().optional(),
          idempotency_key: z.string().optional(),
          n: z.number(),
        })
        .passthrough(),
      trace,
      "input_schema",
    ),
    requiredScopes: overrides.requiredScopes ?? [],
    destructive: overrides.destructive ?? false,
    precheck: () => {
      trace.push("precheck");
      overrides.afterPrecheck?.();
    },
    pathAcl: overrides.pathAclEntries
      ? () => {
          trace.push("path_acl");
          return overrides.pathAclEntries as ReadonlyArray<{ op: AclOp; path: string }>;
        }
      : undefined,
    outputSchema: overrides.outputSchema
      ? tracedSchema(overrides.outputSchema, trace, "output_schema")
      : undefined,
    handler: (input: any, ctx: CallerContext) => {
      trace.push("handler");
      calls.handler += 1;
      if (overrides.handlerThrow) throw overrides.handlerThrow;
      return overrides.handlerReturn ? overrides.handlerReturn(input, ctx) : { ok: true };
    },
  });

  const dispatch = (rawInput: Record<string, unknown>, ctxOver: Partial<CallerContext> = {}) => {
    const input = { ...rawInput };
    if (overrides.vaultField && input.vault === undefined) input.vault = overrides.vaultField;
    return registry.dispatch(
      "tool",
      input,
      baseCtx(db, {
        ...(overrides.grantedScopes ? { grantedScopes: overrides.grantedScopes } : {}),
        ...ctxOver,
      }),
    );
  };

  return { db, calls, dispatch };
}

interface Scenario {
  name: string;
  run: () => Promise<{
    trace: string[];
    result: ToolResult;
    db: Database;
    extraCheck?: () => void;
  }>;
  expectedTrace: string[];
  expectedOk: boolean;
  expectedCode?: string;
}

const scenarios: Scenario[] = [
  {
    name: "success: the full 12-stage ordered trace, exactly",
    async run() {
      const trace: string[] = [];
      const { db, dispatch } = build(trace, {
        destructive: true, // drives BOTH mutating=true (vault-kind gate) and needsHitl=true
        vaultField: "v1",
        pathAclRoot: "/wp4-dummy-root",
        pathAclEntries: [],
        outputSchema: z.object({ ok: z.boolean() }),
      });
      const result = await dispatch({ n: 1 }, { elicitToken: "valid" });
      return { trace, result, db };
    },
    expectedTrace: [
      "input_schema",
      "acl_resolver",
      "vault_kind_resolver",
      "precheck",
      "rate_limiter",
      "verify_elicit",
      "root_resolver",
      "path_acl",
      "handler",
      "output_schema",
      "episode",
      "profile",
    ],
    expectedOk: true,
  },
  {
    name: "schema failure: input_schema is the only stage that ran",
    async run() {
      const trace: string[] = [];
      const { db, dispatch } = build(trace);
      const result = await dispatch({ n: "not-a-number" });
      return { trace, result, db };
    },
    expectedTrace: ["input_schema", "episode"],
    expectedOk: false,
    expectedCode: "validation_error",
  },
  {
    name: "unauthorized: the authenticated check stops before acl_resolver",
    async run() {
      const trace: string[] = [];
      // vaultField is wired (so aclResolver is reachable in principle) precisely so its ABSENCE
      // from the trace is real evidence the authenticated check ran first, not an artifact of
      // acl_resolver never having a reason to fire.
      const { db, dispatch } = build(trace, { requiredScopes: ["read:notes"], vaultField: "v1" });
      const result = await dispatch({ n: 1 }, { authenticated: false });
      return { trace, result, db };
    },
    expectedTrace: ["input_schema", "episode"],
    expectedOk: false,
    expectedCode: "unauthorized",
  },
  {
    name: "missing scope: assertScopesGranted stops before acl_resolver",
    async run() {
      const trace: string[] = [];
      const { db, dispatch } = build(trace, {
        requiredScopes: ["write:notes"],
        grantedScopes: new Set(["read:notes"]), // authenticated, but lacks the required scope
        vaultField: "v1",
      });
      const result = await dispatch({ n: 1 });
      return { trace, result, db };
    },
    expectedTrace: ["input_schema", "episode"],
    expectedOk: false,
    expectedCode: "forbidden",
  },
  {
    name: "vault-binding: the bound-caller guard stops before acl_resolver",
    async run() {
      const trace: string[] = [];
      // vaultField names a DIFFERENT vault than ctx.vaultId ("v1", from baseCtx) — a bound caller
      // may not reach it. acl_resolver is wired and would fire on the very next stage if this
      // guard didn't stop the call first.
      const { db, dispatch } = build(trace, { vaultField: "other-vault" });
      const result = await dispatch({ n: 1 }, { vaultBound: true });
      return { trace, result, db };
    },
    expectedTrace: ["input_schema", "episode"],
    expectedOk: false,
    expectedCode: "forbidden",
  },
  {
    name: "ACL failure: central pathAcl denies AFTER HITL clears (load-bearing order)",
    async run() {
      const trace: string[] = [];
      const root = mkdtempSync(join(tmpdir(), "wp4-acl-"));
      try {
        mkdirSync(join(root, "finance"), { recursive: true });
        writeFileSync(join(root, "finance", "secret.md"), "x");
        // finance/** is in the read whitelist (folder gate passes) but declares a read:finance
        // rule-scope the caller does not hold — P1.4 scope-of-path denial, exercised through the
        // CENTRAL dispatch stage (not a handler-side call).
        const acl = new FolderAcl({
          readOnly: false,
          defaultScopes: [],
          rules: [{ glob: "finance/**", scopes: ["read:finance"] }],
          readPaths: ["finance/**"],
        });
        const { db, dispatch } = build(trace, {
          destructive: true,
          requiredScopes: ["read:notes"],
          grantedScopes: new Set(["read:notes"]), // holds the TOOL scope, not the PATH scope
          vaultField: "v1",
          aclReturn: acl,
          pathAclRoot: root,
          pathAclEntries: [{ op: "read", path: "finance/secret.md" }],
        });
        const result = await dispatch({ n: 1 }, { elicitToken: "valid" });
        return { trace, result, db };
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    expectedTrace: [
      "input_schema",
      "acl_resolver",
      "vault_kind_resolver",
      "precheck",
      "rate_limiter",
      "verify_elicit", // HITL cleared BEFORE the path-ACL denial below
      "root_resolver",
      "path_acl",
      "episode",
    ],
    expectedOk: false,
    expectedCode: "acl_denied",
  },
  {
    name: "HITL failure: elicit_required stops before pathAcl/handler",
    async run() {
      const trace: string[] = [];
      const { db, dispatch } = build(trace, { destructive: true, vaultField: "v1" });
      const result = await dispatch({ n: 1 }, { elicitToken: "not-the-right-token" });
      return { trace, result, db };
    },
    expectedTrace: [
      "input_schema",
      "acl_resolver",
      "vault_kind_resolver",
      "precheck",
      "rate_limiter",
      "verify_elicit",
      "episode",
    ],
    expectedOk: false,
    expectedCode: "elicit_required",
  },
  {
    name: "replay: idempotency claim short-circuits BEFORE throttle/HITL (TOCTOU defense)",
    async run() {
      const trace: string[] = [];
      const { db, dispatch, calls } = build(trace, { destructive: true, vaultField: "v1" });
      // First call carries a valid elicit token, so HITL clears and the call completes normally
      // (the verifier double at ~line 108 is stateless — it checks the token string, it does not
      // consume anything; nothing here relies on single-use semantics).
      const first = await dispatch({ n: 1, idempotency_key: "K1" }, { elicitToken: "valid" });
      expect(first.ok).toBe(true);
      // Isolate `trace` to the REPLAY call under test.
      trace.length = 0;
      // Second call carries NO elicit token at all. If idempotency ran AFTER throttle/HITL (the
      // bug this test exists to catch), this would fail with elicit_required instead of replaying.
      const second = await dispatch({ n: 1, idempotency_key: "K1" });
      return {
        trace,
        result: second,
        db,
        extraCheck: () => {
          expect(calls.handler).toBe(1); // the handler never re-ran
          if (first.ok && second.ok) expect(second.data).toEqual(first.data);
        },
      };
    },
    expectedTrace: ["input_schema", "acl_resolver", "vault_kind_resolver", "precheck", "episode"],
    expectedOk: true,
  },
  {
    name: "overflow: output_schema runs, THEN the byte-budget check fails",
    async run() {
      const trace: string[] = [];
      const { db, dispatch } = build(trace, {
        outputSchema: z.object({ blob: z.string() }),
        handlerReturn: () => ({ blob: "x".repeat(50) }),
        maxResponseBytes: 10,
      });
      const result = await dispatch({ n: 1 });
      return { trace, result, db };
    },
    expectedTrace: [
      "input_schema",
      "precheck",
      "rate_limiter",
      "handler",
      "output_schema",
      "episode",
    ],
    expectedOk: false,
    expectedCode: "overflow",
  },
  {
    name: "abort: a mid-pipeline cancellation stops before rate_limiter",
    async run() {
      const trace: string[] = [];
      const ctrl = new AbortController();
      const { db, dispatch } = build(trace, { afterPrecheck: () => ctrl.abort() });
      const result = await dispatch({ n: 1 }, { signal: ctrl.signal });
      return { trace, result, db };
    },
    expectedTrace: ["input_schema", "precheck", "episode"],
    expectedOk: false,
    expectedCode: "aborted",
  },
  {
    name: "handler error: a non-typed throw is redacted to internal, still audited",
    async run() {
      const trace: string[] = [];
      const { db, dispatch } = build(trace, { handlerThrow: new Error("boom") });
      const result = await dispatch({ n: 1 });
      return { trace, result, db };
    },
    expectedTrace: ["input_schema", "precheck", "rate_limiter", "handler", "episode"],
    expectedOk: false,
    expectedCode: "internal",
  },
];

describe("dispatch pipeline stage order (WP4.0 gate-trace)", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      const { trace, result, db, extraCheck } = await scenario.run();
      try {
        // The full ordered sequence, not a subset: any dropped, added, or reordered stage fails
        // this and prints the actual vs. expected sequence. For the three authorization gates
        // with no seam of their own (unauthorized / missing scope / vault-binding), this is what
        // proves they ran BEFORE acl_resolver: acl_resolver is wired in every scenario, so its
        // absence from a short trace is a real negative, not an unwired double.
        expect(trace).toEqual(scenario.expectedTrace);
        expect(result.ok).toBe(scenario.expectedOk);
        if (!result.ok && scenario.expectedCode)
          expect(result.error.code).toBe(scenario.expectedCode);
        extraCheck?.();
      } finally {
        db.close?.();
      }
    });
  }
});
