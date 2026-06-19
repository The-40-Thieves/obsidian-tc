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
    verifyAndConsumeElicit(ctx.db, ctx.elicitToken, hash, ctx.vaultId, ctx.now ?? Date.now);
  if (!ok)
    throw err.elicitRequired("human confirmation required", {
      args_hash: hash,
      ...(proposed ?? {}),
    });
}
