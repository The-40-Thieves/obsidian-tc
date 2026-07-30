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
// Several pipeline stages have NO injectable double at all: the tool lookup + disabled check, the
// vault-binding guard, all three checkAborted() boundary checks, the idempotency claim/read/
// finalize (a raw ctx.db write, not a seam), the durable markEffectCommitted write, and the
// byte-overflow size check itself. Their existence is still exercised — every scenario reaches
// the outcome those stages are responsible for — but nothing in `trace` names them directly. See
// the report for what that means for this gate's blind spots.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
 *  all 8 scenarios below — so each scenario's expected trace is a genuine "this seam did/did not
 *  fire" claim against a pipeline that COULD have called it, not a consequence of that scenario
 *  simply not wiring it. */
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
    onEpisode: () => trace.push("audit"),
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

  return { calls, dispatch };
}

interface Scenario {
  name: string;
  run: () => Promise<{ trace: string[]; result: ToolResult; extraCheck?: () => void }>;
  expectedTrace: string[];
  expectedOk: boolean;
  expectedCode?: string;
  /** Explicit belt-and-suspenders checks (redundant with `expectedTrace`'s exact-array match, but
   *  each failure names the ONE missing/extra stage on its own, per scenario). */
  notCalled: string[];
}

const scenarios: Scenario[] = [
  {
    name: "success: the full 12-stage ordered trace, exactly",
    async run() {
      const trace: string[] = [];
      const { dispatch } = build(trace, {
        destructive: true, // drives BOTH mutating=true (vault-kind gate) and needsHitl=true
        vaultField: "v1",
        pathAclRoot: "/wp4-dummy-root",
        pathAclEntries: [],
        outputSchema: z.object({ ok: z.boolean() }),
      });
      const result = await dispatch({ n: 1 }, { elicitToken: "valid" });
      return { trace, result };
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
      "audit",
      "profile",
    ],
    expectedOk: true,
    notCalled: [],
  },
  {
    name: "schema failure: input_schema is the only stage that ran",
    async run() {
      const trace: string[] = [];
      const { dispatch } = build(trace);
      const result = await dispatch({ n: "not-a-number" });
      return { trace, result };
    },
    expectedTrace: ["input_schema", "audit"],
    expectedOk: false,
    expectedCode: "validation_error",
    notCalled: [
      "acl_resolver",
      "vault_kind_resolver",
      "precheck",
      "rate_limiter",
      "verify_elicit",
      "root_resolver",
      "path_acl",
      "handler",
      "output_schema",
      "profile",
    ],
  },
  {
    name: "ACL failure: central pathAcl denies AFTER HITL clears (load-bearing order)",
    async run() {
      const trace: string[] = [];
      const root = mkdtempSync(join(tmpdir(), "wp4-acl-"));
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
      const { dispatch } = build(trace, {
        destructive: true,
        requiredScopes: ["read:notes"],
        grantedScopes: new Set(["read:notes"]), // holds the TOOL scope, not the PATH scope
        vaultField: "v1",
        aclReturn: acl,
        pathAclRoot: root,
        pathAclEntries: [{ op: "read", path: "finance/secret.md" }],
      });
      const result = await dispatch({ n: 1 }, { elicitToken: "valid" });
      return { trace, result };
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
      "audit",
    ],
    expectedOk: false,
    expectedCode: "acl_denied",
    notCalled: ["handler", "output_schema", "profile"],
  },
  {
    name: "HITL failure: elicit_required stops before pathAcl/handler",
    async run() {
      const trace: string[] = [];
      const { dispatch } = build(trace, { destructive: true, vaultField: "v1" });
      const result = await dispatch({ n: 1 }, { elicitToken: "not-the-right-token" });
      return { trace, result };
    },
    expectedTrace: [
      "input_schema",
      "acl_resolver",
      "vault_kind_resolver",
      "precheck",
      "rate_limiter",
      "verify_elicit",
      "audit",
    ],
    expectedOk: false,
    expectedCode: "elicit_required",
    notCalled: ["root_resolver", "path_acl", "handler", "output_schema", "profile"],
  },
  {
    name: "replay: idempotency claim short-circuits BEFORE throttle/HITL (TOCTOU defense)",
    async run() {
      const trace: string[] = [];
      const { dispatch, calls } = build(trace, { destructive: true, vaultField: "v1" });
      // First call spends the elicit token and completes normally.
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
        extraCheck: () => {
          expect(calls.handler).toBe(1); // the handler never re-ran
          if (first.ok && second.ok) expect(second.data).toEqual(first.data);
        },
      };
    },
    expectedTrace: ["input_schema", "acl_resolver", "vault_kind_resolver", "precheck", "audit"],
    expectedOk: true,
    notCalled: [
      "rate_limiter",
      "verify_elicit",
      "root_resolver",
      "path_acl",
      "handler",
      "output_schema",
      "profile",
    ],
  },
  {
    name: "overflow: output_schema runs, THEN the byte-budget check fails",
    async run() {
      const trace: string[] = [];
      const { dispatch } = build(trace, {
        outputSchema: z.object({ blob: z.string() }),
        handlerReturn: () => ({ blob: "x".repeat(50) }),
        maxResponseBytes: 10,
      });
      const result = await dispatch({ n: 1 });
      return { trace, result };
    },
    expectedTrace: [
      "input_schema",
      "precheck",
      "rate_limiter",
      "handler",
      "output_schema",
      "audit",
    ],
    expectedOk: false,
    expectedCode: "overflow",
    notCalled: [
      "acl_resolver",
      "vault_kind_resolver",
      "verify_elicit",
      "root_resolver",
      "path_acl",
      "profile",
    ],
  },
  {
    name: "abort: a mid-pipeline cancellation stops before rate_limiter",
    async run() {
      const trace: string[] = [];
      const ctrl = new AbortController();
      const { dispatch } = build(trace, { afterPrecheck: () => ctrl.abort() });
      const result = await dispatch({ n: 1 }, { signal: ctrl.signal });
      return { trace, result };
    },
    expectedTrace: ["input_schema", "precheck", "audit"],
    expectedOk: false,
    expectedCode: "aborted",
    notCalled: [
      "rate_limiter",
      "verify_elicit",
      "root_resolver",
      "path_acl",
      "handler",
      "output_schema",
      "profile",
    ],
  },
  {
    name: "handler error: a non-typed throw is redacted to internal, still audited",
    async run() {
      const trace: string[] = [];
      const { dispatch } = build(trace, { handlerThrow: new Error("boom") });
      const result = await dispatch({ n: 1 });
      return { trace, result };
    },
    expectedTrace: ["input_schema", "precheck", "rate_limiter", "handler", "audit"],
    expectedOk: false,
    expectedCode: "internal",
    notCalled: [
      "acl_resolver",
      "vault_kind_resolver",
      "verify_elicit",
      "root_resolver",
      "path_acl",
      "output_schema",
      "profile",
    ],
  },
];

describe("dispatch pipeline stage order (WP4.0 gate-trace)", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      const { trace, result, extraCheck } = await scenario.run();
      // The full ordered sequence, not a subset: any dropped, added, or reordered stage fails
      // this and prints the actual vs. expected sequence.
      expect(trace).toEqual(scenario.expectedTrace);
      for (const label of scenario.notCalled) expect(trace).not.toContain(label);
      expect(result.ok).toBe(scenario.expectedOk);
      if (!result.ok && scenario.expectedCode)
        expect(result.error.code).toBe(scenario.expectedCode);
      extraCheck?.();
    });
  }
});
