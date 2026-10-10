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

export function asResourceProtocolError(e: unknown, uri: string): Error {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string" && RESOURCE_CALLER_FAULTS.has(code)) {
    return new ResourceNotFoundError(
      uri,
      (e as { message?: string }).message ?? `not found: ${uri}`,
    );
  }
  // Anything else is rethrown untouched, so a genuine internal failure keeps reporting as one.
  return e instanceof Error ? e : new Error(String(e));
}
