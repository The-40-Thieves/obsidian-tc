// A spent confirmation goes back only when dispatch positively knows the call had no effect: a refusal
// thrown before the handler was entered (the central path ACL, the abort check, a marker refusal), or
// the write gate's own convention_blocked raised before any write of the call. Every other failure
// keeps it spent, so one approval can never be redeemed twice. A release is bound to the same tool +
// arguments the token was minted for, never extends its lifetime, and runs through the verifier that
// consumed the token.
import { join } from "node:path";
import { ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { type AclConfigT, FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { elicitVerifier, issueElicitToken } from "../src/elicit";
import {
  type CallerContext,
  type ConventionsSink,
  type ToolDefinition,
  ToolRegistry,
  type VerifyElicit,
} from "../src/mcp/registry";
import { registerM6Tools } from "../src/tools/m6";
import { gateNoteWrite } from "../src/vault/write-gate";
import { STATUS_RULES } from "./conventions-helpers";
import { openMemoryDb } from "./helpers";
import { makeM6Vault } from "./m6-helpers";
import { makeTempDir, rmTemp } from "./tmp";

const MEETING = "meetings/SCHEMA.md";
const BAD = "---\nstatus: bogus\n---\nold\n";
const CALLER = "test";
const VAULT = "test";
const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? "ok" : r.error?.code);

describe("a pre-effect refusal of a confirmed bulk_move_notes releases its confirmation", () => {
  const bulkVault = () =>
    makeM6Vault({
      conventions: true,
      files: {
        [MEETING]: STATUS_RULES("block"),
        "lax/SCHEMA.md": STATUS_RULES("warn"),
        "lax/a.md": BAD,
      },
      register: (reg, deps) =>
        registerM6Tools(reg, {
          ...deps,
          toolSurface: () => ({ config: reg.visibilityConfig(), tools: reg.list() }),
        }),
    });
  const input = {
    vault: "test",
    dry_run: false,
    moves: [{ from: "lax/a.md", to: "meetings/a2.md" }],
  };
  const refuseOnce = async (v: ReturnType<typeof bulkVault>) => {
    const first = await v.call("bulk_move_notes", input);
    expect(code(first)).toBe("elicit_required");
    const argsHash = (first.ok ? undefined : first.error.details?.args_hash) as string;
    const token = issueElicitToken(v.db, {
      vaultId: v.id,
      toolName: "bulk_move_notes",
      argsHash,
      caller: CALLER,
    });
    const refused = await v.call("bulk_move_notes", input, { elicitToken: token });
    expect(code(refused)).toBe("convention_blocked");
    return token;
  };

  it("bulk_move_notes real run refused by convention_blocked: the same token and the same arguments succeed once the destination rules no longer block", async () => {
    const v = bulkVault();
    try {
      const token = await refuseOnce(v);
      // The destination folder's rules are relaxed (a SCHEMA.md the confirmation does not bind).
      v.write(MEETING, STATUS_RULES("warn"));
      const retry = await v.call("bulk_move_notes", input, { elicitToken: token });
      expect(retry.ok ? "ok" : JSON.stringify(retry.error)).toBe("ok");
      expect(v.read("meetings/a2.md")).toBe(BAD);
    } finally {
      v.cleanup();
    }
  });

  it("a released bulk_move_notes token whose bound state then changes is refused as replay_drift", async () => {
    const v = bulkVault();
    try {
      const token = await refuseOnce(v);
      v.write(MEETING, STATUS_RULES("warn"));
      v.write("lax/a.md", "---\nstatus: bogus\n---\nedited since the approval\n");
      const retry = await v.call("bulk_move_notes", input, { elicitToken: token });
      expect(code(retry)).toBe("replay_drift");
      expect(v.exists("meetings/a2.md")).toBe(false);
    } finally {
      v.cleanup();
    }
  });
});

type Input = { mode: string; idempotency_key?: string };
type Gate = { write(text: string, rel?: string): void };
interface BuildOpts {
  /** null: no verifier at all; undefined: the built-in one. */
  verify?: VerifyElicit;
  onInternalError?: (tool: string, vaultId: string, err: unknown) => void;
  strictOutputSchema?: boolean;
  db?: ReturnType<typeof openMemoryDb>;
}

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmTemp(r);
});

/** A destructive, keyable tool under a write gate that refuses any note text containing BLOCK. */
function build(
  behave: (ctx: CallerContext, input: Input, gate: Gate) => unknown,
  o: BuildOpts = {},
) {
  const db =
    o.db ??
    (() => {
      const d = openMemoryDb();
      provisionCacheDb(d);
      return d;
    })();
  const root = makeTempDir("elicit-release-");
  roots.push(root);
  const sink: ConventionsSink = {
    begin: async () => ({}),
    check: async () => undefined,
    gate: () => ({
      check: (_abs, text) => {
        if (text.includes("BLOCK"))
          throw new ObsidianTcError("convention_blocked", "would add a block violation");
      },
    }),
  };
  const registry = new ToolRegistry({
    verifyElicit: o.verify ?? elicitVerifier,
    rootResolver: () => root,
    conventions: sink,
    ...(o.onInternalError ? { onInternalError: o.onInternalError } : {}),
    ...(o.strictOutputSchema ? { strictOutputSchema: true } : {}),
  });
  const gate: Gate = {
    write: (text, rel = "notes/target.md") => gateNoteWrite(join(root, rel), text),
  };
  registry.register({
    name: "rr_gated",
    description: "test-only destructive tool",
    inputSchema: z.object({ mode: z.string(), idempotency_key: z.string().optional() }).strict(),
    outputSchema: z.object({ ok: z.boolean(), conventions: z.unknown().optional() }).strict(),
    acceptsIdempotencyKey: true,
    requiredScopes: ["write:notes"],
    destructive: true,
    confirmationTargets: "none",
    pathAcl: () => [{ op: "write", path: "notes/target.md" }],
    handler: (input: Input, ctx: CallerContext) => behave(ctx, input, gate),
  } as unknown as ToolDefinition);
  const ctx = (over: Partial<CallerContext> = {}): CallerContext => ({
    caller: CALLER,
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: VAULT,
    db,
    ...over,
  });
  const raise = async (input: Record<string, unknown>, caller = CALLER) => {
    const first = await registry.dispatch("rr_gated", input, ctx({ caller }));
    if (first.ok || first.error.code !== "elicit_required") throw new Error("expected a raise");
    return (first.error.details as { args_hash: string }).args_hash;
  };
  const mint = async (input: Record<string, unknown>, now?: () => number) =>
    issueElicitToken(db, {
      vaultId: VAULT,
      toolName: "rr_gated",
      argsHash: await raise(input),
      caller: CALLER,
      ...(now ? { now } : {}),
    });
  const call = (
    input: Record<string, unknown>,
    token?: string,
    over: Partial<CallerContext> = {},
  ) =>
    registry.dispatch(
      "rr_gated",
      input,
      ctx({ ...(token ? { elicitToken: token } : {}), ...over }),
    );
  const row = (token: string) =>
    db.prepare("SELECT consumed_at, expires_at FROM elicit_tokens WHERE token = ?").get(token) as {
      consumed_at: number | null;
      expires_at: number;
    };
  const released = () =>
    (
      db
        .prepare("SELECT COUNT(*) AS n FROM event_log WHERE event_type = 'hitl_released'")
        .get() as { n: number }
    ).n;
  return { registry, db, raise, mint, call, row, released, ctx };
}

/** A handler that writes through the gate: BLOCK while `state.refuse`, counted once let through. */
const gated =
  (state: { refuse: boolean; applied: number }) => (_c: CallerContext, _i: Input, g: Gate) => {
    g.write(state.refuse ? "BLOCK" : "fine");
    state.applied += 1;
    return { ok: true };
  };

describe("the release rule: only a positive pre-effect fact hands the confirmation back", () => {
  it("a write-gate refusal before any write releases it: the same token and the same arguments succeed", async () => {
    const s = { refuse: true, applied: 0 };
    const b = build(gated(s));
    const input = { mode: "a" };
    const token = await b.mint(input);
    expect(code(await b.call(input, token))).toBe("convention_blocked");
    expect(b.row(token).consumed_at).toBeNull();
    s.refuse = false;
    const retry = await b.call(input, token);
    expect(retry.ok ? "ok" : JSON.stringify(retry.error)).toBe("ok");
    expect(s.applied).toBe(1);
    expect(code(await b.call(input, token))).toBe("elicit_required");
  });

  it("a pre-effect refusal then a retry with the same token and DIFFERENT arguments still needs confirmation", async () => {
    const s = { refuse: true, applied: 0 };
    const b = build(gated(s));
    const token = await b.mint({ mode: "a" });
    expect(code(await b.call({ mode: "a" }, token))).toBe("convention_blocked");
    s.refuse = false;
    expect(code(await b.call({ mode: "b" }, token))).toBe("elicit_required");
    expect(b.row(token).consumed_at).toBeNull();
    // The token still redeems for the arguments it was minted for.
    expect(code(await b.call({ mode: "a" }, token))).toBe("ok");
  });

  it("a confirmed call that commits an effect and then fails spends its token: a retry gets elicit_required", async () => {
    let applied = 0;
    const b = build((ctx) => {
      applied += 1;
      ctx.markEffectCommitted?.();
      throw new ObsidianTcError("internal", "failed after the effect");
    });
    const input = { mode: "a" };
    const token = await b.mint(input);
    expect((await b.call(input, token)).ok).toBe(false);
    expect(b.row(token).consumed_at).not.toBeNull();
    expect(code(await b.call(input, token))).toBe("elicit_required");
    expect(applied).toBe(1);
  });

  it("a successful run spends its token: a retry gets elicit_required", async () => {
    const b = build(() => ({ ok: true }));
    const input = { mode: "a" };
    const token = await b.mint(input);
    expect((await b.call(input, token)).ok).toBe(true);
    expect(b.row(token).consumed_at).not.toBeNull();
    expect(code(await b.call(input, token))).toBe("elicit_required");
  });

  it("a released token keeps its original expiry: once the expiry passes it is refused even after a release", async () => {
    const s = { refuse: true, applied: 0 };
    const b = build(gated(s));
    const input = { mode: "a" };
    const t0 = Date.now();
    const token = await b.mint(input, () => t0);
    const expiresAt = b.row(token).expires_at;
    expect(code(await b.call(input, token, { now: () => t0 }))).toBe("convention_blocked");
    expect(b.row(token).consumed_at).toBeNull();
    expect(b.row(token).expires_at).toBe(expiresAt);
    s.refuse = false;
    expect(code(await b.call(input, token, { now: () => expiresAt + 1 }))).toBe("elicit_required");
  });

  it("a convention_blocked the handler throws itself (not the write gate's) keeps the token spent", async () => {
    const b = build(() => {
      throw new ObsidianTcError("convention_blocked", "not raised by the write gate");
    });
    const input = { mode: "a" };
    const token = await b.mint(input);
    expect(code(await b.call(input, token))).toBe("convention_blocked");
    expect(b.row(token).consumed_at).not.toBeNull();
    expect(code(await b.call(input, token))).toBe("elicit_required");
  });

  it("a write-gate refusal after an earlier write was let through keeps the token spent", async () => {
    const b = build((_c, _i, g) => {
      g.write("fine", "notes/one.md");
      g.write("BLOCK", "notes/two.md");
      return { ok: true };
    });
    const input = { mode: "a" };
    const token = await b.mint(input);
    expect(code(await b.call(input, token))).toBe("convention_blocked");
    expect(b.row(token).consumed_at).not.toBeNull();
  });

  it("a write-gate refusal after a non-note write keeps the token spent", async () => {
    const b = build((_c, _i, g) => {
      g.write("{}", "boards/plan.canvas");
      g.write("BLOCK");
      return { ok: true };
    });
    const input = { mode: "a" };
    const token = await b.mint(input);
    expect(code(await b.call(input, token))).toBe("convention_blocked");
    expect(b.row(token).consumed_at).not.toBeNull();
  });

  it("a write-gate refusal the handler replaces with its own error keeps the token spent", async () => {
    const b = build((_c, _i, g) => {
      try {
        g.write("BLOCK");
      } catch {
        throw new ObsidianTcError("convention_blocked", "rethrown as a different error");
      }
      return { ok: true };
    });
    const input = { mode: "a" };
    const token = await b.mint(input);
    expect(code(await b.call(input, token))).toBe("convention_blocked");
    expect(b.row(token).consumed_at).not.toBeNull();
  });

  it("an output-schema fault after the handler returned keeps the token spent", async () => {
    let applied = 0;
    const b = build(
      () => {
        applied += 1;
        return { ok: true, extra: "drift" };
      },
      { strictOutputSchema: true },
    );
    const input = { mode: "a" };
    const token = await b.mint(input);
    const first = await b.call(input, token);
    expect(first.ok).toBe(false);
    expect(b.row(token).consumed_at).not.toBeNull();
    expect(code(await b.call(input, token))).toBe("elicit_required");
    expect(applied).toBe(1);
  });

  it("a central path ACL refusal after the HITL gate releases it: the same token works once access is fixed", async () => {
    let applied = 0;
    const b = build(() => {
      applied += 1;
      return { ok: true };
    });
    const input = { mode: "a" };
    // Minted with no raise of this caller on record, the token binds no state, so the HITL gate does
    // not read the ACL and the central path ACL right before the handler is what refuses.
    const token = issueElicitToken(b.db, {
      vaultId: VAULT,
      toolName: "rr_gated",
      argsHash: await b.raise(input, "minter"),
      caller: CALLER,
    });
    const deny: AclConfigT = {
      readOnly: false,
      defaultScopes: [],
      rules: [],
      writePaths: ["x/**"],
    };
    const refused = await b.call(input, token, { acl: new FolderAcl(deny) });
    expect(code(refused)).toBe("acl_denied");
    expect(applied).toBe(0);
    expect(b.row(token).consumed_at).toBeNull();
    expect(code(await b.call(input, token))).toBe("ok");
    expect(applied).toBe(1);
  });

  it("a keyed call that also carries a token, refused before any write, is released once and replays correctly", async () => {
    const s = { refuse: true, applied: 0 };
    const b = build(gated(s));
    const input = { mode: "a", idempotency_key: "k1" };
    const token = await b.mint(input);
    expect(code(await b.call(input, token))).toBe("convention_blocked");
    expect(b.row(token).consumed_at).toBeNull();
    expect(b.released()).toBe(1);
    s.refuse = false;
    // The claim was released with the token: the same key and the same token run the call once.
    const retry = await b.call(input, token);
    expect(code(retry)).toBe("ok");
    expect(s.applied).toBe(1);
    expect(b.row(token).consumed_at).not.toBeNull();
    // A replay of the key serves the cached result without the handler or a confirmation.
    const replay = await b.call(input);
    expect(code(replay)).toBe("ok");
    expect(replay.meta?.idempotent_replay).toBe(true);
    expect(s.applied).toBe(1);
    expect(b.released()).toBe(1);
  });

  it("two concurrent calls with one token apply the effect at most once", async () => {
    let entered = 0;
    let applied = 0;
    const b = build(async (_c, _i, g) => {
      entered += 1;
      const mine = entered;
      await new Promise((r) => setTimeout(r, 30));
      g.write(mine === 1 ? "BLOCK" : "fine");
      applied += 1;
      return { ok: true };
    });
    const input = { mode: "a" };
    const token = await b.mint(input);
    const [x, y] = await Promise.all([b.call(input, token), b.call(input, token)]);
    expect([code(x), code(y)].sort()).toEqual(["convention_blocked", "elicit_required"]);
    expect(code(await b.call(input, token))).toBe("ok");
    expect(code(await b.call(input, token))).toBe("elicit_required");
    expect(applied).toBe(1);
  });

  it("a failed release with a throwing diagnostics sink still returns the refusal and writes the audit row", async () => {
    const real = openMemoryDb();
    provisionCacheDb(real);
    let failRelease = false;
    const db = new Proxy(real, {
      get(t, p) {
        if (p === "prepare")
          return (sql: string) => {
            if (failRelease && /SET consumed_at = NULL/.test(sql)) throw new Error("injected");
            return t.prepare(sql);
          };
        const v = (t as unknown as Record<PropertyKey, unknown>)[p];
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const sunk: string[] = [];
    const b = build((_c, _i, g) => g.write("BLOCK"), {
      db,
      onInternalError: (tool) => {
        sunk.push(tool);
        throw new Error("sink down");
      },
    });
    const input = { mode: "a" };
    const token = await b.mint(input);
    failRelease = true;
    const r = await b.call(input, token);
    expect(code(r)).toBe("convention_blocked");
    expect(sunk).toEqual(["elicit_release:rr_gated"]);
    expect(b.row(token).consumed_at).not.toBeNull();
    const rows = real
      .prepare("SELECT error_code FROM event_log WHERE tool_name = 'rr_gated' AND status = 'error'")
      .all() as Array<{ error_code: string }>;
    expect(rows.map((x) => x.error_code)).toContain("convention_blocked");
  });

  it("a custom verifier without release never hands a token back", async () => {
    const custom: VerifyElicit = (token, hash, ctx, fp) => elicitVerifier(token, hash, ctx, fp);
    const s = { refuse: true, applied: 0 };
    const b = build(gated(s), { verify: custom });
    const input = { mode: "a" };
    const token = await b.mint(input);
    expect(code(await b.call(input, token))).toBe("convention_blocked");
    expect(b.row(token).consumed_at).not.toBeNull();
    expect(b.released()).toBe(0);
  });

  it("a release records an hitl_released event for the call's arguments", async () => {
    const b = build(gated({ refuse: true, applied: 0 }));
    const input = { mode: "a" };
    const hash = await b.raise(input);
    const token = issueElicitToken(b.db, {
      vaultId: VAULT,
      toolName: "rr_gated",
      argsHash: hash,
      caller: CALLER,
    });
    await b.call(input, token);
    const ev = b.db
      .prepare("SELECT args_hash, status FROM event_log WHERE event_type = 'hitl_released'")
      .all();
    expect(ev).toEqual([{ args_hash: hash, status: "skipped" }]);
  });

  it("a confirmed call on a context an in-flight keyed call already marks is refused before its handler, and its token is released", async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => {
      releaseA = r;
    });
    let enteredA!: () => void;
    const inA = new Promise<void>((r) => {
      enteredA = r;
    });
    let applied = 0;
    const b = build(() => {
      applied += 1;
      return { ok: true };
    });
    // A keyed, unconfirmed tool that parks until the test lets it finish.
    b.registry.register({
      name: "rr_keyed",
      description: "test-only keyed tool",
      inputSchema: z.object({ idempotency_key: z.string() }).strict(),
      acceptsIdempotencyKey: true,
      requiredScopes: ["write:notes"],
      handler: async () => {
        enteredA();
        await gateA;
        return { ok: true };
      },
    } as unknown as ToolDefinition);
    const input = { mode: "b" };
    const token = await b.mint(input);
    const shared = b.ctx() as CallerContext & { markEffectCommitted?: () => void };
    const pA = b.registry.dispatch("rr_keyed", { idempotency_key: "A" }, shared);
    await inA;
    shared.elicitToken = token;
    const bRes = await b.registry.dispatch("rr_gated", input, shared);
    delete shared.elicitToken;
    // A's marker is live on the shared object: the confirmed call refuses that context loudly.
    expect(code(bRes)).toBe("internal");
    expect(applied).toBe(0);
    expect(b.row(token).consumed_at).toBeNull();
    releaseA();
    expect(code(await pA)).toBe("ok");
    expect(shared.markEffectCommitted).toBeUndefined();
    const next = await b.registry.dispatch("rr_keyed", { idempotency_key: "N" }, shared);
    expect(code(next)).toBe("ok");
    expect(code(await b.call(input, token))).toBe("ok");
    expect(applied).toBe(1);
  });
});
