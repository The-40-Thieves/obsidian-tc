// A single-use confirmation that a refused call spent goes back unspent when the call is refused
// before any effect (GH #1381). checkHitl spends the token through the verifier it is handed, so
// trackElicitSpend wraps that verifier to remember the token it actually spent.
import type { Database } from "../../db/types";
import { releaseElicitToken } from "../../elicit";
import type { VerifyElicit } from "./types";

export interface ElicitSpend {
  readonly verify: VerifyElicit | undefined;
  token(): string | undefined;
}

export function trackElicitSpend(verify: VerifyElicit | undefined): ElicitSpend {
  let spent: string | undefined;
  return {
    verify:
      verify &&
      ((token, expectedHash, ctx, currentFp) => {
        const ok = verify(token, expectedHash, ctx, currentFp);
        if (ok) spent = token;
        return ok;
      }),
    token: () => spent,
  };
}

/** Releases the token only when no effect was committed. A release fault is reported, never thrown:
 *  it must not replace the refusal the caller has to see. */
export function releaseSpentElicit(
  spend: ElicitSpend,
  ctx: { db: Database; vaultId: string },
  committed: boolean,
  onError: ((tool: string, vaultId: string, err: unknown) => void) | undefined,
  tool: string,
): void {
  const token = spend.token();
  if (token === undefined || committed) return;
  try {
    releaseElicitToken(ctx.db, token);
  } catch (err) {
    onError?.(`elicit_release:${tool}`, ctx.vaultId, err);
  }
}
