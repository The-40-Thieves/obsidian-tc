// A confirmation is spent only by a call that reaches an effect. A refusal before any effect
// releases the single-use token exactly as it releases the idempotency claim, so the caller can
// correct the input and retry with the same confirmation. The release is bound to the same
// tool + arguments the token was minted for, never extends its lifetime, and never runs once an
// effect has been committed.
import { ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { provisionCacheDb } from "../src/db/provision";
import { elicitVerifier, issueElicitToken } from "../src/elicit";
import { type CallerContext, type ToolDefinition, ToolRegistry } from "../src/mcp/registry";
import { registerM6Tools } from "../src/tools/m6";
import { STATUS_RULES } from "./conventions-helpers";
import { openMemoryDb } from "./helpers";
import { makeM6Vault } from "./m6-helpers";

const MEETING = "meetings/SCHEMA.md";
const BAD = "---\nstatus: bogus\n---\nold\n";
const CALLER = "test";
const VAULT = "test";

describe("a pre-effect refusal of a confirmed bulk_move_notes releases its confirmation", () => {
  it("bulk_move_notes real run refused by convention_blocked: the same token and the same arguments succeed once the destination rules no longer block", async () => {
    const v = makeM6Vault({
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
    try {
      const input = {
        vault: "test",
        dry_run: false,
        moves: [{ from: "lax/a.md", to: "meetings/a2.md" }],
      };
      const first = await v.call("bulk_move_notes", input);
      expect(first.ok ? "ok" : first.error.code).toBe("elicit_required");
      const argsHash = (first.ok ? undefined : first.error.details?.args_hash) as string;
      const token = issueElicitToken(v.db, {
        vaultId: v.id,
        toolName: "bulk_move_notes",
        argsHash,
        caller: CALLER,
      });
      const refused = await v.call("bulk_move_notes", input, { elicitToken: token });
      expect(refused.ok ? "ok" : refused.error.code).toBe("convention_blocked");

      // The destination folder's rules are relaxed. Editing a probed path (the moved note) would be
      // replay_drift by design: the confirmation is bound to the target state it was shown.
      v.write(MEETING, STATUS_RULES("warn"));
      const retry = await v.call("bulk_move_notes", input, { elicitToken: token });
      expect(retry.ok ? "ok" : JSON.stringify(retry.error)).toBe("ok");
      expect(v.read("meetings/a2.md")).toBe(BAD);
    } finally {
      v.cleanup();
    }
  });
});

describe("HITL token spend across dispatch outcomes", () => {
  // A destructive tool whose handler refusal and effect are driven by the test.
  const build = (behave: (ctx: CallerContext, input: { mode: string }) => unknown) => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const registry = new ToolRegistry({ verifyElicit: elicitVerifier });
    registry.register({
      name: "rr_gated",
      description: "test-only destructive tool",
      inputSchema: z.object({ mode: z.string() }).strict(),
      requiredScopes: ["write:notes"],
      destructive: true,
      confirmationTargets: "none",
      handler: (input: { mode: string }, ctx: CallerContext) => behave(ctx, input),
    } as unknown as ToolDefinition);
    const ctx = (over: Partial<CallerContext> = {}): CallerContext => ({
      caller: CALLER,
      authenticated: true,
      grantedScopes: new Set(["*"]),
      vaultId: VAULT,
      db,
      ...over,
    });
    const mint = async (input: Record<string, unknown>, now?: () => number) => {
      const first = await registry.dispatch("rr_gated", input, ctx());
      if (first.ok || first.error.code !== "elicit_required") throw new Error("expected a raise");
      return issueElicitToken(db, {
        vaultId: VAULT,
        toolName: "rr_gated",
        argsHash: (first.error.details as { args_hash: string }).args_hash,
        caller: CALLER,
        ...(now ? { now } : {}),
      });
    };
    const call = (
      input: Record<string, unknown>,
      token: string,
      over: Partial<CallerContext> = {},
    ) => registry.dispatch("rr_gated", input, ctx({ elicitToken: token, ...over }));
    const row = (token: string) =>
      db
        .prepare("SELECT consumed_at, expires_at FROM elicit_tokens WHERE token = ?")
        .get(token) as {
        consumed_at: number | null;
        expires_at: number;
      };
    return { registry, mint, call, row };
  };

  it("a pre-effect refusal with the same token and the same arguments releases it: the retry succeeds", async () => {
    let refuse = true;
    let applied = 0;
    const b = build((_ctx, _input) => {
      if (refuse) throw new ObsidianTcError("convention_blocked", "refused before any effect");
      applied += 1;
      return { ok: true };
    });
    const input = { mode: "a" };
    const token = await b.mint(input);
    const refused = await b.call(input, token);
    expect(refused.ok ? "ok" : refused.error.code).toBe("convention_blocked");
    expect(b.row(token).consumed_at).toBeNull();
    refuse = false;
    const retry = await b.call(input, token);
    expect(retry.ok ? "ok" : JSON.stringify(retry.error)).toBe("ok");
    expect(applied).toBe(1);
  });

  it("a pre-effect refusal then a retry with the same token and DIFFERENT arguments still needs confirmation", async () => {
    let refuse = true;
    const b = build(() => {
      if (refuse) throw new ObsidianTcError("convention_blocked", "refused before any effect");
      return { ok: true };
    });
    const token = await b.mint({ mode: "a" });
    expect((await b.call({ mode: "a" }, token)).ok).toBe(false);
    refuse = false;
    const other = await b.call({ mode: "b" }, token);
    expect(other.ok ? "ok" : other.error.code).toBe("elicit_required");
    expect(b.row(token).consumed_at).toBeNull();
    // The token still redeems for the arguments it was minted for.
    expect((await b.call({ mode: "a" }, token)).ok).toBe(true);
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
    const retry = await b.call(input, token);
    expect(retry.ok ? "ok" : retry.error.code).toBe("elicit_required");
    expect(applied).toBe(1);
  });

  it("a successful run spends its token: a retry gets elicit_required", async () => {
    const b = build(() => ({ ok: true }));
    const input = { mode: "a" };
    const token = await b.mint(input);
    expect((await b.call(input, token)).ok).toBe(true);
    expect(b.row(token).consumed_at).not.toBeNull();
    const retry = await b.call(input, token);
    expect(retry.ok ? "ok" : retry.error.code).toBe("elicit_required");
  });

  it("a released token keeps its original expiry: once the expiry passes it is refused even after a release", async () => {
    let refuse = true;
    const b = build(() => {
      if (refuse) throw new ObsidianTcError("convention_blocked", "refused before any effect");
      return { ok: true };
    });
    const input = { mode: "a" };
    const t0 = Date.now();
    const token = await b.mint(input, () => t0);
    const expiresAt = b.row(token).expires_at;
    expect((await b.call(input, token, { now: () => t0 })).ok).toBe(false);
    expect(b.row(token).consumed_at).toBeNull();
    expect(b.row(token).expires_at).toBe(expiresAt);
    refuse = false;
    const late = await b.call(input, token, { now: () => expiresAt + 1 });
    expect(late.ok ? "ok" : late.error.code).toBe("elicit_required");
  });
});
