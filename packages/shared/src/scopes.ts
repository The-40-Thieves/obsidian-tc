export const SCOPE_FAMILIES = ["read", "write", "delete", "execute", "admin", "bulk"] as const;
export type ScopeFamily = (typeof SCOPE_FAMILIES)[number];
export type Scope = string;

// Scopes that always require a HITL elicit confirmation (G2.4 A.3 hardcoded floors).
export const HITL_FLOOR_SCOPES: ReadonlySet<Scope> = new Set<Scope>([
  "admin:auth",
  "write:templater",
]);

// Families where every member is a HITL floor.
export const HITL_FLOOR_FAMILIES: readonly string[] = ["execute", "bulk"];

export function parseScope(s: Scope): { family: string; resource: string } {
  if (s === "*") return { family: "*", resource: "*" };
  const i = s.indexOf(":");
  if (i < 0) return { family: s, resource: "*" };
  return { family: s.slice(0, i), resource: s.slice(i + 1) };
}

// Does the granted set satisfy one required scope, honoring family/global wildcards?
export function grantsScope(granted: Iterable<Scope>, required: Scope): boolean {
  const req = parseScope(required);
  for (const g of granted) {
    if (g === "*") return true;
    const gp = parseScope(g);
    if (gp.family !== "*" && gp.family !== req.family) continue;
    if (gp.resource === "*" || gp.resource === req.resource) return true;
  }
  return false;
}

// AND across all required scopes.
export function grantsAll(granted: Iterable<Scope>, required: readonly Scope[]): boolean {
  const set = granted instanceof Set ? (granted as Set<Scope>) : new Set(granted);
  return required.every((r) => grantsScope(set, r));
}

export function scopeRequiresHitl(scope: Scope): boolean {
  if (HITL_FLOOR_SCOPES.has(scope)) return true;
  return HITL_FLOOR_FAMILIES.includes(parseScope(scope).family);
}

// Scope families that mutate the vault; denied when an ACL is read-only.
export const MUTATING_FAMILIES: readonly string[] = ["write", "delete", "bulk", "execute"];

export function isMutatingScope(scope: Scope): boolean {
  return MUTATING_FAMILIES.includes(parseScope(scope).family);
}
