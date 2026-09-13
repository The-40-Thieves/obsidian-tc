import type { CallerContext } from "./registry";

// THE-1037 (GH #925): bridge an `elicit_token` argument into the caller context, stripping it
// from the args so it never perturbs args_hash — the token is bound to the hash of the call
// WITHOUT the token (see elicit.ts / hitl.ts) — nor reaches a target's `.strict()` schema as an
// unrecognized key. ONE helper, called at every site in server.ts that dispatches a set of tool
// args: the outer tools/call envelope, and again inside call_capability's and the domain facade's
// dispatch closures for their INNER args, which callCapability/domainTools forward untouched. When
// both the outer envelope and an inner args object carry a token, the inner one wins — it is the
// more specific binding, scoped to the call actually being dispatched.
export function splitElicitToken(
  args: Record<string, unknown>,
  ctx: CallerContext,
): { args: Record<string, unknown>; ctx: CallerContext } {
  if (typeof args.elicit_token !== "string") return { args, ctx };
  const { elicit_token, ...rest } = args;
  return { args: rest, ctx: { ...ctx, elicitToken: elicit_token } };
}
