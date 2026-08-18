// THE-647 item 2: named persona bundles for multi-agent HTTP deployments. Leaf schema — imports
// only tools.schema.ts (its own leaf, same precedent as vault.schema.ts importing
// auth-acl.schema.ts's AclConfigSchema); must never import config.schema.ts or server.schema.ts.
//
// A persona composes three mechanisms that already exist independently rather than inventing a
// fourth: THE-267 vault binding (`vaultBound` on CallerContext), the JWT scope grant
// (`grantedScopes`), and THE-219 tool-visibility scoping (`ToolVisibilityConfig`). It is
// server-operator CONFIG — who gets issued a JWT carrying which `persona` claim — never a
// caller-visible tool or a runtime-mutable resource; see auth/persona.ts for the resolution.
import { z } from "zod";
import { ToolVisibilityConfigSchema } from "./tools.schema";

export const PersonaConfigSchema = z.object({
  vaults: z
    .array(z.string())
    .min(1)
    .describe(
      "Vault ids this persona may be bound to. A token's own `vault` claim (when present) must name one of these; absent, the first entry is the default. Resolution FAILS CLOSED on a vault outside this set — never widened to 'any configured vault'.",
    ),
  scopes: z
    .array(z.string())
    .min(1)
    .describe(
      "The scopes a token carrying this persona is granted — REPLACES whatever scopes the token itself carries, never unioned with them, so a persona claim can only narrow or redirect a grant, never widen it beyond what the operator configured here.",
    ),
  toolVisibility: ToolVisibilityConfigSchema.optional().describe(
    "Optional per-persona tool-visibility mask, composed with the server's static `toolVisibility` at the same disabled > hidden > scope_denied > listed chokepoint (THE-645 item 2's existence-oracle constraint still holds). Can only narrow what the static config already allows, never restore a tool the static config hid or disabled.",
  ),
});
export type PersonaConfig = z.infer<typeof PersonaConfigSchema>;

// A name -> bundle map. Wired into ServerConfigObject as `.optional()` — absent (the default)
// means no persona claim can ever resolve; see auth/persona.ts, which fails closed on an
// unrecognised name rather than falling back to the token's own (wider) scopes.
export const PersonasConfigSchema = z.record(z.string(), PersonaConfigSchema);
export type PersonasConfig = z.infer<typeof PersonasConfigSchema>;
