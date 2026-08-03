// m8's shared deps and availability contract.
//
// Lifted out of experiential-tools.ts when goal-tools.ts was split off: both tool modules need
// M8Deps and the `available` discriminated-union helpers, and having the second import them from
// the first created a circular dependency. The repo's no-circular baseline is 0 and the boundary
// gate enforces it, so the shared surface gets its own module rather than a cycle.
import { grantsAll } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { Database } from "../../db/types";
import type { CallerContext } from "../../mcp/registry";

// P1.7 (audit THE-562): the experiential per-principal partition is an AUTHORIZATION boundary, not
// a default filter. Crossing it — reading other principals' episodes (any_caller), forgetting an
// episode you don't own, or stamping feedback across sessions — requires this elevated scope.
// Lives here rather than in experiential-tools.ts because feedback-scope.ts needs it too, and
// importing it from the parent would be the cycle this module exists to prevent.
export const CROSS_PRINCIPAL_SCOPE = "admin:workspace";
export const canCrossPrincipal = (ctx: CallerContext): boolean =>
  grantsAll(ctx.grantedScopes, [CROSS_PRINCIPAL_SCOPE]);

export interface M8Deps {
  /** Open experiential.db handle; absent (all capture/config off) -> tools report unavailable. */
  edb?: Database;
  now?: () => number;
}

// Annotated rather than inferred: a bare object literal widens `available` to `boolean`, which no
// longer matches `Unavailable`'s `z.literal(false)` once a handler's return union is checked
// structurally. Annotating pins the discriminant while leaving `message` a plain `string` — `as
// const` would also freeze the message into a literal type, which is not wanted.
export const UNAVAILABLE: { available: false; message: string } = {
  available: false,
  message:
    "experiential store is not open (enable experiential.logRetrievals, captureEpisodes, or activationRerank)",
};

/** THE-417: the degraded half of every m8 tool's output contract, declared once beside the value it
 *  describes so the two cannot drift. Every tool here returns EITHER this shape or `available: true`
 *  plus its own fields — a discriminated union on `available`, which is what makes these payloads
 *  worth advertising a schema for at all: an agent can branch on one field instead of guessing.
 *
 *  THE-548 found three different "unavailable" shapes across the tool surface (m8's shared object,
 *  m7's ad-hoc `available:false`, and M4 throwing `plugin_missing`). Declaring the contract is what
 *  turns that from a thing you discover by reading handlers into a thing the registry checks. */
const Unavailable = z.object({ available: z.literal(false), message: z.string() });

/** `available: true` plus the tool's own fields. */
export function availableWith<T extends z.ZodRawShape>(shape: T) {
  return z.union([Unavailable, z.object({ available: z.literal(true), ...shape })]);
}
