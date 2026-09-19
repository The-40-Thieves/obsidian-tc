// Handler-side conditional HITL. Always-destructive tools set destructive:true
// and gate in dispatch; tools whose confirmation is *conditional* (overwrite a
// non-empty note, move/copy across a folder boundary, replace frontmatter, run a
// non-dry-run link rewrite) call this instead, so ordinary creates and dry-runs
// never demand confirmation. The token is bound to argsHash(toolName, input);
// callers obtain one via issueElicitToken and resubmit. Single-use is enforced
// by verifyAndConsumeElicit (the UPDATE ... WHERE consumed_at IS NULL).
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { verifyAndConsumeElicit } from "../elicit";
import { argsHash } from "../hash";
import type { CallerContext } from "../mcp/registry";

/**
 * Require a valid, single-use elicit token when `needed` is true. Throws
 * elicit_required (carrying the args_hash to confirm against) when the token is
 * missing/expired/mismatched. No-op when `needed` is false.
 */
export function requireConfirmation(
  ctx: CallerContext,
  toolName: string,
  input: unknown,
  needed: boolean,
  proposed?: Record<string, unknown>,
): void {
  if (!needed) return;
  const hash = argsHash(toolName, input);
  const ok =
    !!ctx.elicitToken &&
    verifyAndConsumeElicit(
      ctx.db,
      ctx.elicitToken,
      hash,
      ctx.vaultId,
      ctx.caller,
      ctx.now ?? Date.now,
    );
  if (!ok)
    // THE-1082 (GH #945; fix round 2, cross-vendor review): `tool`/`vault` ride along so
    // error-rendering.ts's text channel can render the exact `obsidian-tc elicit` command a
    // client with no elicitation support (e.g. Claude Code over stdio) needs to clear this gate —
    // both are already known here (`toolName` param, `ctx.vaultId`) and add nothing an attacker
    // couldn't already see: the caller supplied both to make this very call. `args_hash`'s inputs
    // (toolName, input) are unchanged. `args_hash`/`tool`/`vault` are spread AFTER `proposed` —
    // deliberately last — so a per-call `proposed` object (every caller of this function passes a
    // literal object it wrote itself, but nothing here can prove one never grows a `tool`/`vault`
    // key by accident) can never override the values this function itself computed.
    throw err.elicitRequired("human confirmation required", {
      ...(proposed ?? {}),
      args_hash: hash,
      tool: toolName,
      vault: ctx.vaultId,
    });
}
