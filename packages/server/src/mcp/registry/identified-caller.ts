import { err } from "@the-40-thieves/obsidian-tc-shared";
import type { CallerContext } from "./types";

/**
 * `null` (or empty) is the absence of an identity, not an identity: `===` cannot tell two absences
 * apart, so a verified token with no `sub` would share one task bucket with every other. Only HTTP
 * produces it (stdio is `stdio`, mode `none` is `http-local`); the task surfaces refuse it. Lives in
 * this leaf module so the registry's gates can use it without importing mcp/tasks (a cycle).
 */
export const isIdentifiedCaller = (caller: string | null): caller is string =>
  typeof caller === "string" && caller.length > 0;

/** What a refusal for a missing identity tells the operator: the token is valid, it just names no
 *  one, and the fix is on the issuing side. */
const NO_IDENTITY_HINT =
  "this credential is valid but carries no identity (a token with no `sub` claim; for an oidc provider, the claim named by auth.oidc.claimMapping.subject). Issue the token with a `sub` and retry";

/**
 * Identity gate. `null` is the absence of an identity, not an identity: a valid JWT with no `sub`
 * authenticates as `caller: null`, `IS ?`/`===` cannot tell two such credentials apart, and every
 * one of them would share a single partition. A tool that keeps state per caller declares
 * `principalOwned`; a keyed call (the idempotency namespace is the caller) is checked the same way.
 * Either is refused here, once, instead of by a check in each handler. Returns the caller.
 *
 * Refused rather than given a derived identity (jti / token hash): a re-issued token would then
 * arrive as a stranger to its own work memory and sessions, silently, on every renewal. Stdio is
 * `stdio` and `auth.mode none` is `http-local`; only an HTTP token without a subject reaches this.
 */
export function requireIdentifiedCaller(ctx: Pick<CallerContext, "caller">, what: string): string {
  if (!isIdentifiedCaller(ctx.caller))
    throw err.forbidden(`${what} requires an identified caller: ${NO_IDENTITY_HINT}`, {
      reason: "no_identity",
    });
  return ctx.caller;
}
