import { ResourceNotFoundError } from "@modelcontextprotocol/server";

// Moved out of ./server.ts to keep it under biome's noExcessiveLinesPerFile cap.
/**
 * Map a domain error out of `resources/read` onto the code the spec requires.
 *
 * A `resources/read` miss MUST answer `-32602` (Invalid Params) — the 2026-07-28 revision moved it
 * off the old `-32002`, and the SDK never emits `-32002` at all. Our resource path throws the shared
 * domain errors (`note_not_found`, `invalid_input`, `path_invalid`), which the SDK cannot recognise
 * and therefore reports as `-32603` Internal Error: a CLIENT mistake, reported as a server fault,
 * on the one method the spec calls out by name.
 *
 * Only the caller-fault codes are remapped. An ACL denial or a genuine internal failure is not an
 * invalid parameter, and flattening those into `-32602` would tell a client its request was
 * malformed when the request was fine and the answer was "no".
 */
const RESOURCE_CALLER_FAULTS = new Set([
  "note_not_found",
  "invalid_input",
  "path_invalid",
  "path_ambiguous",
]);

/** The internal reason behind a refusal answered to the caller as `note_not_found`
 *  (resources.ts answeringAsMissing). The caller never sees it: the audit reads it, so a denial is
 *  still counted (dispatchResource, read_resources' deniedItems). */
const internalReasons = new WeakMap<object, string>();

export function withInternalReason<E extends object>(error: E, reason: string): E {
  internalReasons.set(error, reason);
  return error;
}

/** The reason recorded by withInternalReason on `e`, or undefined. */
export function internalReasonOf(e: unknown): string | undefined {
  return typeof e === "object" && e !== null ? internalReasons.get(e) : undefined;
}

export function asResourceProtocolError(e: unknown, uri: string): Error {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string" && RESOURCE_CALLER_FAULTS.has(code)) {
    const mapped = new ResourceNotFoundError(
      uri,
      (e as { message?: string }).message ?? `not found: ${uri}`,
    );
    const reason = internalReasonOf(e);
    return reason === undefined ? mapped : withInternalReason(mapped, reason);
  }
  // Anything else is rethrown untouched, so a genuine internal failure keeps reporting as one.
  return e instanceof Error ? e : new Error(String(e));
}
