/**
 * Caller strings the server itself uses as an identity. State is keyed on `ctx.caller`, so a
 * VERIFIED principal that spelled one of these (a token with `sub=stdio`) would share the internal
 * caller's idempotency rows, work memory and sessions. The stored identities are not renamed
 * (that would orphan every existing user's state); instead no verified credential may take one.
 *
 * Exact names are the fixed `caller:` literals in src (a test derives them from the source and
 * fails when one is missing here); prefixes are namespaces the server composes callers in
 * (`rerun:<caller>`, workspace/rerun.ts) or keeps for future internal callers (`internal:`).
 * Matching is exact and case-sensitive, like every other comparison on a stored caller.
 *
 * Enforced in jwt.ts `identityFrom` on the RESOLVED principal (after `claimMapping`), which jwt,
 * oidc and the bundled authorization server's access tokens all go through (rejection reason
 * `reserved_principal`), and by `token mint`.
 */
export const RESERVED_PRINCIPALS: ReadonlySet<string> = new Set([
  "stdio", // server-runtime.ts: the stdio operator
  "http-local", // transports/http.ts: `auth.mode: none`
  "cli-operator", // cli/commands/{forget,import-*,context-*}.ts
  "prefetch-worker", // cli/commands/prefetch.ts
  "memory-import-cli", // cli/commands/memory-import.ts
]);

export const RESERVED_PRINCIPAL_PREFIXES: readonly string[] = ["rerun:", "internal:"];

export function isReservedPrincipal(principal: string | null | undefined): boolean {
  if (typeof principal !== "string") return false;
  return (
    RESERVED_PRINCIPALS.has(principal) ||
    RESERVED_PRINCIPAL_PREFIXES.some((p) => principal.startsWith(p))
  );
}
