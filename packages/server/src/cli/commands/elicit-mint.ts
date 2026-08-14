// THE-826: `obsidian-tc elicit` — the sanctioned route to a HITL confirmation token for a client
// that does not implement MCP elicitation (SEP-2260/2322; Claude Code among them).
//
// Before this, `issueElicitToken` (../../elicit.ts) was a library symbol with no CLI and no MCP
// tool: a caller blocked on `elicit_required` had no way to satisfy the gate at all. A prior PR
// (THE-824) made the 16 conditionally-gated tools ADVERTISE that gate (elicit_token, dropping
// `destructive: false`) without giving anyone a way to complete it. The unaddressed alternative is
// what the reporter named: the operator shells out and moves the file by hand, and the audit
// trail, the ACL, and the snapshot `restore_note` depends on are all bypassed at once. An
// unreachable control does not stay respected — it gets routed around.
//
// AUTHORIZATION — read this before changing it. Minting a token requires opening the SAME
// cache.db the live server reads `elicit_tokens` from, i.e. filesystem access to
// `<cacheDir>/cache.db`. That same directory already holds `auth.jwtSecret` and every configured
// provider API key; `token-mint.ts` (readAuthBlock) already treats read access to it as sufficient
// authority to issue a bearer credential with wildcard scopes. This command asks for nothing
// stronger: whoever can read that directory can already run `obsidian-tc serve` against it and
// dispatch the exact call being gated, directly, with no confirmation at all. There is no separate
// credential check here because filesystem access to the vault's own state IS the credential — a
// caller who lacks it cannot open the db (openDatabase fails on ENOENT/EACCES under a restrictive
// mode, and a missing `elicit_tokens` table refuses the INSERT), and nothing below adds a fallback
// that would let them mint anyway. That is what keeps this from being a general token faucet: it
// mints exactly the token an operator with that access could already forge by hand-editing the
// table, in a form that is auditable, TTL-correct, and cannot be gotten subtly wrong.
//
// A CLI subcommand rather than an MCP tool, deliberately. Adding a tool moves eight pinned
// surfaces (REGISTERED_TOOL_COUNT, the facade domain map, the boot.tools_registered perf baseline,
// two docgen gates, ACL extraction, vault-arg coverage, m7 metadata parity) for a capability that
// must NOT be callable by the model the gate exists to slow down — it is the human operator's
// escape hatch when their client cannot render the confirmation prompt itself. Wiring it as a tool
// would hand the very agent under the gate a way to clear its own gate.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { type AuditEvent, writeEvent } from "../../audit";
import { openDatabase } from "../../db/open";
import type { Database } from "../../db/types";
import { issueElicitToken } from "../../elicit";
import { CliError } from "../args";
import { type Cmd, resolveOrUsageExit } from "../shared";

/** The parsed `elicit` command — its shape lives in args.ts with every other command. */
export type ElicitMintCmd = Cmd<"elicit-mint">;

export interface ElicitMintPlan {
  vaultId: string;
  toolName: string;
  argsHash: string;
  caller: string | null;
  ttlSeconds: number;
}

/**
 * Decide what to mint, or refuse. Pure — no filesystem, no db, no clock — mirroring `planMint`'s
 * split (token-mint.ts) between DECIDING and DOING, so every refusal here is testable without
 * opening a database.
 */
export function planElicitMint(
  cfg: Pick<ServerConfig, "vaults" | "elicitTtlSeconds">,
  cmd: ElicitMintCmd,
): ElicitMintPlan {
  if (!cmd.hash) {
    throw new CliError(
      "elicit requires --hash (the args_hash the elicit_required error's details carried)",
    );
  }
  if (!cmd.tool) {
    throw new CliError(
      "elicit requires --tool (the tool the confirmation is for). It is recorded for audit, not " +
        "verified on redemption — args_hash already encodes the tool name (see hash.ts's " +
        "argsHash), so a wrong --tool here cannot widen what the token confirms.",
    );
  }
  let vaultId: string;
  if (cmd.vault !== undefined) {
    if (!cfg.vaults.some((v) => v.id === cmd.vault)) {
      throw new CliError(`unknown vault: ${cmd.vault}`);
    }
    vaultId = cmd.vault;
  } else if (cfg.vaults.length === 1) {
    vaultId = cfg.vaults[0]?.id as string;
  } else {
    throw new CliError(
      `${cfg.vaults.length} vaults are configured (${cfg.vaults.map((v) => v.id).join(", ")}) — ` +
        "pass --vault to say which one this confirmation is for. Minting for the wrong vault is " +
        "not a security hole (verifyAndConsumeElicit checks vault_id and simply refuses it) but it " +
        "would waste the single use this token gets.",
    );
  }
  return {
    vaultId,
    toolName: cmd.tool,
    argsHash: cmd.hash,
    // "stdio" matches the caller identity server-runtime.ts's trusted local context stamps on
    // EVERY stdio-transport call (`obsidian-tc serve <vault>`, no auth) — the client this command
    // exists for: a locally-spawned MCP client with no elicitation support, talking over stdio, so
    // its blocked calls always carry caller "stdio". An HTTP/jwt deployment's caller is the
    // bearer token's `sub` claim (the same value given to `token mint --sub`) — pass --caller
    // explicitly there. Guessing it wrong only makes the mint UNREDEEMABLE
    // (verifyAndConsumeElicit's caller check fails closed), never over-broad.
    caller: cmd.caller ?? "stdio",
    // No --ttl flag exists on this command (THE-826 constraint): the mint always uses the SAME
    // config value that governs the live server (setDefaultElicitTtlSeconds, elicit.ts), so it can
    // never mint a token that outlives what that server would itself have issued.
    ttlSeconds: cfg.elicitTtlSeconds,
  };
}

/**
 * Issue the token and record an `event_log` row for it (THE-605's precedent: a CLI write that
 * never goes through registry.dispatch gets no audit row for free — see forget.ts's
 * auditForgetEvent for the identical reasoning and the same fail-open-but-not-silent shape). The
 * row never carries the token itself, only what identifies the mint (vault, tool, args_hash,
 * caller): the token is not a secret worth writing into a log a wider audience reads, it is the
 * secret this whole command exists to hand to exactly one operator on stdout (hazard 5).
 */
export function mintElicitAudited(
  db: Database,
  plan: ElicitMintPlan,
  opts: { now?: () => number } = {},
): string {
  const now = opts.now ?? Date.now;
  const t0 = now();
  const token = issueElicitToken(db, {
    vaultId: plan.vaultId,
    toolName: plan.toolName,
    argsHash: plan.argsHash,
    caller: plan.caller,
    ttlSeconds: plan.ttlSeconds,
    now,
  });
  try {
    const e: AuditEvent = {
      ts: t0,
      vault_id: plan.vaultId,
      tool_name: plan.toolName,
      caller: plan.caller,
      duration_ms: now() - t0,
      status: "ok",
      args_hash: plan.argsHash,
      event_type: "elicit_minted",
    };
    writeEvent(db, e);
  } catch (err) {
    // Fail-open, but NOT silent — same shape as forget.ts's auditForgetEvent, for the same reason:
    // a security-relevant write nobody can tell went unaudited is a smaller instance of the exact
    // defect THE-605 exists to close. The token is already minted at this point (issueElicitToken
    // above did not throw); losing the audit row does not lose the confirmation.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `warning: elicit token minted, but the audit_events row could not be written (${msg}).\n`,
    );
  }
  return token;
}

export async function run_elicit_mint(cmd: ElicitMintCmd): Promise<void> {
  const cfg = resolveOrUsageExit(cmd.configPath);
  const plan = planElicitMint(cfg, cmd);
  // Not provisioned here, deliberately, matching metrics.ts/forget.ts: this command only makes
  // sense once a real server has already blocked a real call, and that server (serve or index)
  // already provisioned cache.db. mkdirSync alone covers the directory-not-yet-created case; a
  // missing `elicit_tokens` table (a vault that has never been served) surfaces its own
  // "no such table" error from the INSERT below rather than silently provisioning one here.
  mkdirSync(cfg.cacheDir, { recursive: true });
  const db = await openDatabase(join(cfg.cacheDir, "cache.db"));
  try {
    const token = mintElicitAudited(db, plan);
    if (cmd.json) {
      // The token rides in this object too — --json is for a caller that is going to parse it out
      // of stdout programmatically either way, same tradeoff `token mint --json` already makes.
      process.stdout.write(
        `${JSON.stringify(
          {
            token,
            vault: plan.vaultId,
            tool: plan.toolName,
            args_hash: plan.argsHash,
            caller: plan.caller,
            ttlSeconds: plan.ttlSeconds,
          },
          null,
          2,
        )}\n`,
      );
      return;
    }
    // Same split as `token mint`: every human-facing line goes to stderr, the bare token alone on
    // stdout, so `obsidian-tc elicit ... 2>/dev/null` (or piping the output straight into the
    // retried tool call) never picks up anything but the secret. THE-826 hazard 5: the token must
    // reach nowhere but stdout here — not the audit row above (which never carries it), not this
    // stderr line, not argv (it is only ever produced by this command, never accepted as input).
    process.stderr.write(
      `minted elicit token for tool=${plan.toolName} vault=${plan.vaultId} caller=${plan.caller} ` +
        `ttl=${plan.ttlSeconds}s args_hash=${plan.argsHash}\n`,
    );
    process.stdout.write(`${token}\n`);
  } finally {
    db.close?.();
  }
}
