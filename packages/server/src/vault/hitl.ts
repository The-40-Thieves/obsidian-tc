// Handler-side conditional HITL. Always-destructive tools set destructive:true
// and gate in dispatch; tools whose confirmation is *conditional* (overwrite a
// non-empty note, move/copy across a folder boundary, replace frontmatter, run a
// non-dry-run link rewrite) call this instead, so ordinary creates and dry-runs
// never demand confirmation. The token is bound to argsHash(toolName, input);
// callers obtain one via issueElicitToken and resubmit. Single-use is enforced
// by verifyAndConsumeElicit (the UPDATE ... WHERE consumed_at IS NULL).
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { verifyAndConsumeElicit } from "../elicit";
import { hitlSatisfiedByState } from "../elicit-request-state";
import { argsHash } from "../hash";
import type { CallerContext } from "../mcp/registry";

/**
 * Require a valid, single-use elicit token when `needed` is true. Throws
 * elicit_required (carrying the args_hash to confirm against) when the token is
 * missing/expired/mismatched. No-op when `needed` is false.
 *
 * THE-1106 fix round 2 (HIGH, cross-vendor review — measured, not inferred): this gate used to
 * check ONLY `ctx.elicitToken`, never `ctx.elicitState` — the ONLY caller of `hitlSatisfiedByState`
 * was dispatch's `checkHitl` (policy-gates.ts). For these 16 handler-side conditionally-gated
 * tools (write_note overwrite, move/copy_note, move_attachment, update_frontmatter replace,
 * rewrite_link, prune_hub_links, restore_note, create/update_canvas, create_base, save_workspace,
 * create_excalidraw, update_task, ocr_bulk), an SDK legacy-shim or modern client-driven round trip
 * that approved the confirmation still re-entered the handler, which threw `elicit_required`
 * AGAIN — offering a fresh round every time (measured: 8 legs, 0 writes, "still required input
 * after 8 rounds", no args_hash, no CLI fallback) instead of ever completing. Fixed to accept
 * EITHER path, mirroring `checkHitl` exactly. Safe: `ctx.elicitState` is set (mcp/server.ts's
 * `resolveElicitConfirmation`) ONLY after the confirm leg's OWN response was verified to be
 * `{action: "accept", content: {approve: true}}` — trusting it here carries the identical
 * guarantee `verifyAndConsumeElicit` gives the token path, not a weaker one.
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
  const tokenOk =
    !!ctx.elicitToken &&
    verifyAndConsumeElicit(
      ctx.db,
      ctx.elicitToken,
      hash,
      ctx.vaultId,
      ctx.caller,
      ctx.now ?? Date.now,
    );
  const stateOk =
    !tokenOk &&
    hitlSatisfiedByState(ctx.elicitState, {
      tool: toolName,
      argsHash: hash,
      vaultId: ctx.vaultId,
      caller: ctx.caller,
    });
  if (tokenOk || stateOk) {
    // THE-1106 fix round 2: dispatch's OWN `checkHitl` success path relays `tc.elicit.consumed`,
    // but only for dispatch-gated (`destructive: true`/HITL-floored-scope) tools — it never ran
    // for these handler-side-only gates, on EITHER path (token or state), so this was already true
    // before this fix for the token path too. Scoped to the NEW state path only (what this fix
    // round adds): `ctx.relayElicitConsumed` is set (mcp/server.ts) only when a verified,
    // accept+approve:true state exists for this connection, so audit now sees a shim/modern
    // approval clearing one of these 16 tools' gates, which it could not see before.
    if (stateOk) ctx.relayElicitConsumed?.(toolName);
    return;
  }
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
