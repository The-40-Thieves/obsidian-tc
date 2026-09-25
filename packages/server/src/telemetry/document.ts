// THE-1125 — the ONE shape the telemetry document is allowed to take. `.strict()` is the
// enforcement mechanism, not a formality: every key not listed here is a schema-validation
// failure, so a future field added to `TelemetrySnapshot` (collector.ts) without a matching
// schema key fails `buildTelemetryDocument`'s own `.parse()` loudly, in dev and in CI (see
// test/telemetry-document.test.ts's property test), rather than silently reaching the network.
//
// This is the SAME shape-of-defense the zod/ajv note in the repo's own memory describes for tool
// outputs (a strict schema that REJECTS extra keys, not one that silently strips them) — this
// document is validated with `.parse()` (throws on violation), never `.safeParse()` (which would
// strip and pass).
import { z } from "zod";

export const TELEMETRY_SCHEMA_VERSION = "obsidian-tc.telemetry/1";

/** Bound how many distinct client names / label counters one document can carry — an unbounded
 *  agent that renames itself per call, or a tool/error-code label with unexpected cardinality,
 *  must never grow the document without limit. 32 mirrors the ticket's own cap on distinct client
 *  names; the same ceiling is reused for tool/error-code map SIZE (not per-call counts) so a
 *  degenerate config cannot blow the document up either. */
export const MAX_CLIENT_NAMES = 32;

const CountMap = z.record(z.string().min(1).max(200), z.number().int().nonnegative());

export const TelemetryDocumentSchema = z
  .object({
    schema: z.literal(TELEMETRY_SCHEMA_VERSION),
    installId: z.string().uuid(),
    serverVersion: z.string().min(1),
    os: z.string().min(1),
    arch: z.string().min(1),
    facadeMode: z.enum(["triad", "domain", "flat"]),
    clientNames: z.array(z.string().min(1).max(128)).max(MAX_CLIENT_NAMES),
    toolCalls: CountMap,
    errorCodes: CountMap,
    windowStart: z.number().int().nonnegative(),
    windowEnd: z.number().int().nonnegative(),
  })
  .strict();

export type TelemetryDocument = z.infer<typeof TelemetryDocumentSchema>;

/** The exact set of keys `TelemetryDocumentSchema` allows — used by the forbidden-fields property
 *  test to assert closure without re-deriving the list by hand (and drifting from the schema). */
export const TELEMETRY_DOCUMENT_KEYS = Object.freeze(
  Object.keys(TelemetryDocumentSchema.shape),
) as readonly string[];

/** Build + validate one telemetry document. Throws (never returns an invalid shape) when the
 *  inputs cannot satisfy the strict schema — e.g. an installId that is not a UUID, which would
 *  itself be a symptom of state.ts's invariant breaking. Callers (sender.ts, the `preview`/CLI
 *  paths) must not catch this to "send something anyway"; a document that cannot be built
 *  correctly must not be sent at all. */
export function buildTelemetryDocument(input: {
  installId: string;
  serverVersion: string;
  os: string;
  arch: string;
  facadeMode: "triad" | "domain" | "flat";
  clientNames: readonly string[];
  toolCalls: Readonly<Record<string, number>>;
  errorCodes: Readonly<Record<string, number>>;
  windowStart: number;
  windowEnd: number;
}): TelemetryDocument {
  return TelemetryDocumentSchema.parse({
    schema: TELEMETRY_SCHEMA_VERSION,
    installId: input.installId,
    serverVersion: input.serverVersion,
    os: input.os,
    arch: input.arch,
    facadeMode: input.facadeMode,
    clientNames: input.clientNames.slice(0, MAX_CLIENT_NAMES),
    toolCalls: input.toolCalls,
    errorCodes: input.errorCodes,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
  });
}
