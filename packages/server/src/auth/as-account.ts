// The account's own upper bounds on what any grant may carry (design v2 section 4.5): `users.scopes_allowed`
// and `users.vaults_allowed`, each space- or comma-separated, null = unbounded. They are read from the
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
  raw === null || raw.trim() === "" ? undefined : raw.split(/[\s,]+/).filter(Boolean);

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

export type Bounded = { ok: true; scopes: string[] } | { ok: false; reason: "vault" | "scopes" };

/** The scopes the bounds leave, or why nothing may be issued: a vault outside them, or no scope left. */
export function applyBounds(
  bounds: AccountBounds,
  want: { scopes: readonly string[]; vault: string | null },
): Bounded {
  if (want.vault !== null && bounds.vaults !== undefined && !bounds.vaults.includes(want.vault)) {
    return { ok: false, reason: "vault" };
  }
  const allowed = bounds.scopes;
  const scopes =
    allowed === undefined ? [...want.scopes] : want.scopes.filter((s) => grantsScope(allowed, s));
  return scopes.length === 0 ? { ok: false, reason: "scopes" } : { ok: true, scopes };
}
