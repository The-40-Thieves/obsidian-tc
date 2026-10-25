// A single-use confirmation a refused call spent goes back unspent only when dispatch positively knows
// the call could not have had an effect. checkHitl spends the token through the verifier it is handed,
// so trackElicitSpend wraps that verifier to remember the token it actually spent, and the release runs
// through the same verifier's `release`. A verifier without one never releases.
import { elicitVerifier, withSpendSlot } from "../../elicit";
import type { StateProbe } from "../../elicit-drift";
import { recordHitlOutcome } from "../../hitl-telemetry";
import { report } from "./conventions-scope";
import type { CallerContext, RegistryOptions, VerifyElicit } from "./types";

/** A confirmation token this dispatch spent, with the release that undoes the spend. `argsHash` is the
 *  hash the token was verified against: the key its hitl_accept row carries, so a release pairs with it. */
interface Spend {
  readonly token: string;
  readonly argsHash: string;
  readonly release: VerifyElicit["release"];
}

export interface ElicitSpend {
  readonly verify: VerifyElicit | undefined;
  /** Runs `run` with the handler-side confirmations it spends recorded on this dispatch. */
  scope<T>(run: () => T): T;
  spent(): Spend | undefined;
}

export function trackElicitSpend(verify: VerifyElicit | undefined): ElicitSpend {
  let spent: Spend | undefined;
  const tracked: VerifyElicit | undefined =
    verify &&
    Object.assign(
      (token: string, expectedHash: string, ctx: CallerContext, currentFp?: StateProbe) => {
        const ok = verify(token, expectedHash, ctx, currentFp);
        if (ok) spent = { token, argsHash: expectedHash, release: verify.release };
        return ok;
      },
      { release: verify.release },
    );
  return {
    verify: tracked,
    // A handler-side confirmation is consumed by the built-in verifier (vault/hitl.ts), so it is released by
    // that verifier's release, whichever verifyElicit this registry was given. At most one token is spent per
    // call: a call carries one token and the built-in consume is single-use, so a second spend cannot succeed.
    scope: (run) =>
      withSpendSlot((token, argsHash) => {
        spent = { token, argsHash, release: elicitVerifier.release };
      }, run),
    spent: () => spent,
  };
}

/** Where a failed call stood when it threw. */
export interface RefusalPoint {
  /** The handler was entered: any throw from here on may follow an effect. */
  handlerInvoked: boolean;
  handlerReturned: boolean;
  effectCommitted: boolean;
  /** The thrown error is the write gate's convention_blocked, raised before any write of this call. */
  refusedBeforeWrite: boolean;
}

/** The release rule. True only on a positive pre-effect fact: a refusal thrown before the handler was
 *  entered, or the write gate's refusal before any write, with no effect signalled. Never inferred
 *  from a missing commit signal: a timeout or a bridge error after the request may follow an effect. */
function refusedBeforeEffect(p: RefusalPoint): boolean {
  if (p.handlerReturned || p.effectCommitted) return false;
  return !p.handlerInvoked || p.refusedBeforeWrite;
}

/** Releases the spent token through the verifier that spent it, and records the release. A release
 *  fault leaves the token spent and is reported, never thrown: it must not replace the refusal the
 *  caller has to see, and neither may a diagnostics sink that itself throws. */
export function releaseSpentElicit(
  spend: ElicitSpend,
  ctx: CallerContext,
  point: RefusalPoint,
  onError: RegistryOptions["onInternalError"],
  tool: string,
): void {
  const spent = spend.spent();
  if (spent === undefined || spent.release === undefined || !refusedBeforeEffect(point)) return;
  try {
    spent.release(spent.token, ctx);
  } catch (err) {
    report(onError, `elicit_release:${tool}`, ctx.vaultId, err);
    return;
  }
  recordHitlOutcome(ctx, { tool, argsHash: spent.argsHash, outcome: "released", source: "token" });
}
