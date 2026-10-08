// The account's own upper bounds on what any grant may carry (design v2 section 4.5): `users.scopes_allowed`
// and `users.vaults_allowed`, each space- or comma-separated; ONLY SQL NULL is unbounded (an empty or
// blank value is an empty list, which allows nothing). They are read from the
// row at the moment of every decision (consent approval, a remembered consent, the token exchange), never
// copied into a grant or a code, so narrowing an account takes effect on everything not yet issued.
import { grantsScope } from "@the-40-thieves/obsidian-tc-shared";
import type { Database } from "../db/types";

export interface AccountBounds {
  /** Undefined = unbounded. */
  scopes?: string[];
  /** Undefined = unbounded. */
  vaults?: string[];
}

const list = (raw: string | null): string[] | undefined =>
  raw === null ? undefined : raw.split(/[\s,]+/).filter(Boolean);

/** The bounds of an ENABLED account, or undefined when `sub` is not one (gone or disabled: nothing may issue). */
export function accountBounds(db: Database, sub: string): AccountBounds | undefined {
  const row = db
    .prepare(
      "SELECT scopes_allowed, vaults_allowed FROM users WHERE sub = ? AND disabled_at IS NULL",
    )
    .get(sub) as { scopes_allowed: string | null; vaults_allowed: string | null } | undefined;
  if (row === undefined) return undefined;
  const scopes = list(row.scopes_allowed);
  const vaults = list(row.vaults_allowed);
  return { ...(scopes ? { scopes } : {}), ...(vaults ? { vaults } : {}) };
}

export type Bounded =
  | { ok: true; scopes: string[]; vault: string | null }
  | { ok: false; reason: "vault" | "scopes" };

/** The scopes the bounds leave (possibly none). */
export const narrowScopes = (bounds: AccountBounds, scopes: readonly string[]): string[] => {
  const allowed = bounds.scopes;
  return allowed === undefined ? [...scopes] : scopes.filter((s) => grantsScope(allowed, s));
};

/**
 * The scopes the bounds leave and the vault the token binds to, or why nothing may be issued: a vault
 * outside the bounds, no concrete vault for a vault-bounded account, or no scope left. A token with no
 * `vault` claim rides the server's DEFAULT vault, which the account's bounds know nothing about, so a
 * vault-bounded account never gets an unbound token: with no vault chosen it gets its one permitted
 * vault, and with several the operator must choose (consent persona). Unbounded accounts keep `null`.
 */
export function applyBounds(
  bounds: AccountBounds,
  want: { scopes: readonly string[]; vault: string | null },
): Bounded {
  let vault = want.vault;
  if (bounds.vaults !== undefined) {
    vault = want.vault ?? (bounds.vaults.length === 1 ? (bounds.vaults[0] ?? null) : null);
    if (vault === null || !bounds.vaults.includes(vault)) return { ok: false, reason: "vault" };
  }
  const scopes = narrowScopes(bounds, want.scopes);
  return scopes.length === 0 ? { ok: false, reason: "scopes" } : { ok: true, scopes, vault };
}
