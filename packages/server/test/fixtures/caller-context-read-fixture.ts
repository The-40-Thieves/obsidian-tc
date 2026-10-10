// Deliberately NEVER imported by src. test/task-offload-policy.test.ts scans this file to prove the
// CallerContext read scan sees every shape of read, including the ones a `ctx.<key>` regex cannot
// (Codex's case: `const { roots } = ctx; if (!roots) deny();`).
import type { CallerContext } from "../../src/mcp/registry";
import { readsHitlRoute } from "./caller-context-read-helper";

export function destructured(ctx: CallerContext): void {
  const { roots } = ctx;
  if (!roots) throw new Error("deny");
}

export function renamed(ctx: CallerContext): unknown {
  const { now: clock } = ctx;
  return clock;
}

export function literalElement(ctx: CallerContext | undefined): unknown {
  return ctx?.["sample"];
}

/** A helper that is handed only a slice of the context. */
export function viaPick(c: Pick<CallerContext, "traceCarrier">): unknown {
  return c.traceCarrier;
}

export function assigned(ctx: CallerContext): unknown {
  let facadeExplanation: unknown;
  ({ facadeExplanation } = ctx);
  return facadeExplanation;
}

export function callsHelper(ctx: CallerContext): unknown {
  return viaPick(ctx);
}

export function callsOtherModule(ctx: CallerContext): unknown {
  return readsHitlRoute(ctx);
}
