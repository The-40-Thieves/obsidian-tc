import { ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import type { CallerContext, RegistryOptions, ToolDefinition } from "./types";

// WP4.3: result governance — output-schema validation (warn vs strict) and the byte-budget/
// overflow check, pulled out of registry.ts's runDispatch unchanged, plus the memoizeSerialized/
// takeSerialized pair and its module-scoped WeakMap. WP4.1 and WP4.2 both deferred that pair to
// here rather than splitting it across an earlier slice; it moves as one unit, in this commit.

// THE-294 — single-serialization contract. runDispatch stringifies a successful result once for
// the byte governor; the transport formatter (mcp/server.ts formatData) consumes that string via
// this memo instead of re-stringifying the same object. Entries are take-and-delete (consumed by
// exactly the request that produced them), and only non-null objects are memoized — primitives
// fall through to the formatter's own cheap stringify. If two concurrent dispatches ever return
// the SAME object reference, the later write wins; both stringify the identical reference, so
// the text is correct unless the object is mutated in between (no handler does this).
const serializedResults = new WeakMap<object, string>();

export function memoizeSerialized(data: unknown, json: string): void {
  if (data !== null && typeof data === "object") serializedResults.set(data as object, json);
}

export function takeSerialized(data: unknown): string | undefined {
  if (data === null || typeof data !== "object") return undefined;
  const s = serializedResults.get(data as object);
  if (s !== undefined) serializedResults.delete(data as object);
  return s;
}

/** THE-457 (audit #4): default strict output-schema validation ON in test/CI, so a handler whose
 *  payload drifts from its advertised outputSchema fails a test instead of shipping warn-only to a
 *  client. Vitest sets NODE_ENV=test, so the existing suite exercises every real handler under strict
 *  validation; OBSIDIAN_TC_STRICT_OUTPUT_SCHEMA=1 opts in elsewhere (a CI job, a local run). Production
 *  sets neither and stays warn-only for backward compatibility; an explicit strictOutputSchema wins. */
export function strictOutputSchemaDefault(): boolean {
  return process.env.NODE_ENV === "test" || process.env.OBSIDIAN_TC_STRICT_OUTPUT_SCHEMA === "1";
}

/**
 * THE-278 hardening (warn-mode): the handler's success payload must match the advertised
 * outputSchema. Validates and surfaces drift to the operator, but never throws in warn mode — a
 * schema mismatch must not turn a working call into a client-visible failure. A no-op when the
 * tool declares no outputSchema, or when the payload matches.
 *
 * THE-417 Phase 2: `onOutputSchemaDrift` is a DEDICATED seam, not just the onInternalError line —
 * warn-mode's whole job is to surface latent mismatches over real traffic, and a stderr line among
 * every other internal error is not a runnable "let warn-mode run for a while" signal. Fired in
 * BOTH warn and strict mode. Deliberately NOT parsed back out of the `output_schema:` prefix on
 * the onInternalError call: a stringly-typed discriminator on a diagnostics message is exactly the
 * kind of coupling that breaks silently when someone reworks the message.
 *
 * THE-457: in strict mode (dev/CI) a schema-contract violation is a hard, typed error — caught by
 * the dispatch catch-all and returned as internal_error — rather than silently shipping a payload
 * a conformant client may reject. Production stays warn-only.
 */
export function checkOutputSchema(
  def: Pick<ToolDefinition, "outputSchema">,
  out: unknown,
  name: string,
  ctx: Pick<CallerContext, "vaultId">,
  strict: boolean,
  onInternalError: RegistryOptions["onInternalError"],
  onOutputSchemaDrift: RegistryOptions["onOutputSchemaDrift"],
): void {
  if (!def.outputSchema) return;
  const outCheck = def.outputSchema.safeParse(out);
  if (outCheck.success) return;
  try {
    onInternalError?.(
      `output_schema:${name}`,
      ctx.vaultId,
      new Error(`output does not match advertised outputSchema: ${outCheck.error.message}`),
    );
  } catch {
    /* diagnostics sink must never break dispatch */
  }
  try {
    onOutputSchemaDrift?.(name, ctx.vaultId);
  } catch {
    /* observability is never load-bearing */
  }
  if (strict) {
    throw new ObsidianTcError(
      "internal_error",
      `output does not match advertised outputSchema for ${name}`,
    );
  }
}

/** Whether a serialized result exceeds the configured byte budget. */
export function isOverflow(resultSize: number, maxResponseBytes: number): boolean {
  return resultSize > maxResponseBytes;
}

/** The overflow error, shared by the real byte-budget check and the idempotency terminal-overflow
 *  replay (registry.ts) — same code, message, and details in both places. */
export function overflowError(resultSize: number, maxResponseBytes: number): ObsidianTcError {
  return new ObsidianTcError("overflow", "response exceeds byte budget", {
    result_size: resultSize,
    limit: maxResponseBytes,
  });
}
