// THE-826: `obsidian-tc elicit` — the CLI mint path for a client that does not implement MCP
// elicitation. `planElicitMint` is pure (mirrors token-mint.test.ts's planMint split), so every
// refusal below runs with no filesystem, no db and no clock. `mintElicitAudited` is exercised
// against a real in-memory cache.db to prove the token it produces actually satisfies
// verifyAndConsumeElicit — and, symmetrically, is REFUSED when any bound field doesn't match.
import { type ServerConfig, ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { CliError } from "../src/cli/args";
import {
  type ElicitMintCmd,
  mintElicitAudited,
  planElicitMint,
} from "../src/cli/commands/elicit-mint";
import { provisionCacheDb } from "../src/db/provision";
import { verifyAndConsumeElicit } from "../src/elicit";
import { openMemoryDb } from "./helpers";

function freshDb() {
  const db = openMemoryDb();
  provisionCacheDb(db);
  return db;
}

// Parsed through the real schema (not a hand-rolled literal) so `vaults` and `elicitTtlSeconds`
// carry every field the ServerConfig type actually requires, the same way dispatch-parity.test.ts
// and cli-args.test.ts build a config fixture.
const cfg = (
  vaults: Array<{ id: string; path: string }> = [{ id: "main", path: "/vault" }],
  elicitTtlSeconds?: number,
): Pick<ServerConfig, "vaults" | "elicitTtlSeconds"> =>
  ServerConfigSchema.parse({
    vaults,
    ...(elicitTtlSeconds !== undefined ? { elicitTtlSeconds } : {}),
  });

const cmd = (over: Partial<ElicitMintCmd> = {}): ElicitMintCmd => ({
  kind: "elicit-mint",
  hash: "deadbeefcafe",
  tool: "move_note",
  ...over,
});

describe("planElicitMint — refusals", () => {
  it("refuses without --hash", () => {
    expect(() => planElicitMint(cfg(), cmd({ hash: undefined }))).toThrow(CliError);
    expect(() => planElicitMint(cfg(), cmd({ hash: undefined }))).toThrow(/--hash/);
  });

  it("refuses without --tool", () => {
    expect(() => planElicitMint(cfg(), cmd({ tool: undefined }))).toThrow(CliError);
    expect(() => planElicitMint(cfg(), cmd({ tool: undefined }))).toThrow(/--tool/);
  });

  it("refuses an unknown --vault", () => {
    expect(() => planElicitMint(cfg(), cmd({ vault: "nope" }))).toThrow(/unknown vault/);
  });

  it("refuses an ambiguous multi-vault config with no --vault", () => {
    const multi = cfg([
      { id: "a", path: "/a" },
      { id: "b", path: "/b" },
    ]);
    expect(() => planElicitMint(multi, cmd())).toThrow(/pass --vault/);
  });
});

describe("planElicitMint — what it produces", () => {
  it("defaults to the single configured vault when --vault is omitted", () => {
    expect(planElicitMint(cfg(), cmd()).vaultId).toBe("main");
  });

  it("takes an explicit --vault among several configured", () => {
    const multi = cfg([
      { id: "a", path: "/a" },
      { id: "b", path: "/b" },
    ]);
    expect(planElicitMint(multi, cmd({ vault: "b" })).vaultId).toBe("b");
  });

  it('defaults caller to "stdio" — the trusted local transport this command targets', () => {
    expect(planElicitMint(cfg(), cmd()).caller).toBe("stdio");
  });

  it("lets an explicit --caller override the stdio default (HTTP/jwt deployments)", () => {
    expect(planElicitMint(cfg(), cmd({ caller: "alice" })).caller).toBe("alice");
  });

  it("always uses the configured elicitTtlSeconds — there is no ttl override on this command", () => {
    expect(planElicitMint(cfg(undefined, 900), cmd()).ttlSeconds).toBe(900);
    // ElicitMintCmd (args.ts) has no `ttl` field at all, so there is nothing here that could ever
    // widen it — this asserts the value came from config, not from the command.
    expect(cmd()).not.toHaveProperty("ttl");
  });

  it("carries --hash and --tool through verbatim", () => {
    const plan = planElicitMint(cfg(), cmd({ hash: "h1", tool: "delete_note" }));
    expect(plan.argsHash).toBe("h1");
    expect(plan.toolName).toBe("delete_note");
  });
});

describe("mintElicitAudited — the token it produces is exactly what verifyAndConsumeElicit expects", () => {
  it("mints a token that satisfies the gate for the vault/hash/caller it was minted for", () => {
    const db = freshDb();
    const plan = planElicitMint(cfg(), cmd());
    const token = mintElicitAudited(db, plan);
    expect(token).toHaveLength(32);
    expect(verifyAndConsumeElicit(db, token, plan.argsHash, plan.vaultId, plan.caller)).toBe(true);
  });

  it("is single-use: the same token fails on second redemption", () => {
    const db = freshDb();
    const plan = planElicitMint(cfg(), cmd());
    const token = mintElicitAudited(db, plan);
    expect(verifyAndConsumeElicit(db, token, plan.argsHash, plan.vaultId, plan.caller)).toBe(true);
    expect(verifyAndConsumeElicit(db, token, plan.argsHash, plan.vaultId, plan.caller)).toBe(false);
  });

  it("REFUSES redemption against a different args_hash (a different tool or different args)", () => {
    const db = freshDb();
    const plan = planElicitMint(cfg(), cmd({ hash: "h1" }));
    const token = mintElicitAudited(db, plan);
    expect(verifyAndConsumeElicit(db, token, "h2-different-op", plan.vaultId, plan.caller)).toBe(
      false,
    );
    // Not consumed by the failed attempt — the rightful redemption still works.
    expect(verifyAndConsumeElicit(db, token, "h1", plan.vaultId, plan.caller)).toBe(true);
  });

  it("REFUSES redemption against a different vault", () => {
    const db = freshDb();
    const plan = planElicitMint(cfg(), cmd());
    const token = mintElicitAudited(db, plan);
    expect(verifyAndConsumeElicit(db, token, plan.argsHash, "other-vault", plan.caller)).toBe(
      false,
    );
    expect(verifyAndConsumeElicit(db, token, plan.argsHash, plan.vaultId, plan.caller)).toBe(true);
  });

  it("REFUSES redemption by a different caller than the one it was minted for", () => {
    const db = freshDb();
    const plan = planElicitMint(cfg(), cmd({ caller: "alice" }));
    const token = mintElicitAudited(db, plan);
    expect(verifyAndConsumeElicit(db, token, plan.argsHash, plan.vaultId, "bob")).toBe(false);
    expect(verifyAndConsumeElicit(db, token, plan.argsHash, plan.vaultId, "alice")).toBe(true);
  });

  it("expires after ttlSeconds, honouring the injected clock", () => {
    const db = freshDb();
    let t = 1_000_000;
    const now = () => t;
    const plan = planElicitMint(cfg(undefined, 60), cmd());
    const token = mintElicitAudited(db, plan, { now });
    t += 61_000; // one second past the 60s TTL
    expect(verifyAndConsumeElicit(db, token, plan.argsHash, plan.vaultId, plan.caller, now)).toBe(
      false,
    );
  });

  it("stays valid right up to the TTL boundary", () => {
    const db = freshDb();
    let t = 1_000_000;
    const now = () => t;
    const plan = planElicitMint(cfg(undefined, 60), cmd());
    const token = mintElicitAudited(db, plan, { now });
    t += 59_000; // still within the 60s TTL
    expect(verifyAndConsumeElicit(db, token, plan.argsHash, plan.vaultId, plan.caller, now)).toBe(
      true,
    );
  });

  it("writes an event_log audit row identifying the mint, never carrying the token", () => {
    const db = freshDb();
    const plan = planElicitMint(cfg(), cmd({ hash: "h1", tool: "delete_note" }));
    const token = mintElicitAudited(db, plan, { now: () => 1_234_567 });
    const rows = db
      .prepare(
        "SELECT vault_id, tool_name, caller, args_hash, event_type, status FROM event_log WHERE event_type = 'elicit_minted'",
      )
      .all() as Array<{
      vault_id: string;
      tool_name: string;
      caller: string;
      args_hash: string;
      event_type: string;
      status: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      vault_id: "main",
      tool_name: "delete_note",
      caller: "stdio",
      args_hash: "h1",
      event_type: "elicit_minted",
      status: "ok",
    });
    // The whole point of hazard 5: the secret goes to the caller (the return value), never into a
    // row a wider audience can read.
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(token);
  });
});
