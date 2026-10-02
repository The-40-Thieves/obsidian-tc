import type { ObsidianTcError, ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { type DispatchObservability, telemetryDetail } from "./dispatch-observability";
import type { CallerContext } from "./types";

/** The terminal-error answer to a keyed call that hit an existing idempotency row (an
 *  `indeterminate_outcome` or a replayed overflow): audit it, count the hit and the failed call,
 *  and return the error result. The handler did not run this time either (THE-741), hence
 *  `idempotent_replay`. `extraMeta` carries the overflow figures. */
export function idempotentErrorReplay(
  observability: DispatchObservability,
  ctx: CallerContext,
  name: string,
  audit: (status: "error", durationMs: number, resultSize: number, code: string) => void,
  e: ObsidianTcError,
  duration: number,
  resultSize: number,
  extraMeta: Record<string, number> = {},
): ToolResult {
  audit("error", duration, resultSize, e.code);
  observability.meter((m) => {
    m.incIdempotencyHit(ctx.vaultId, name);
    m.observeToolCall(
      ctx.vaultId,
      name,
      "error",
      duration / 1000,
      resultSize,
      telemetryDetail(ctx, e.code),
    );
  });
  return {
    ok: false,
    error: e.toJSON(),
    meta: { duration_ms: duration, result_size: resultSize, ...extraMeta, idempotent_replay: true },
  };
}
