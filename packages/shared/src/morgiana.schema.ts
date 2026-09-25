import { z } from "zod";

// MORGIANA event schema (G2.4 §MORGIANA events — THE-183). CloudEvents 1.0 envelope plus the
// shared data shape. Lives in @the-40-thieves/obsidian-tc-shared so the server emitter AND MORGIANA itself
// validate against one source of truth; the `specversion` field is the schema version, so a
// breaking change bumps it. Spool/HTTP transport + emission live server-side (src/morgiana/).

/** The CloudEvents `type` values MORGIANA recognizes (G2.4 §Event types + additive extensions). */
export const MORGIANA_EVENT_TYPES = [
  "tc.tool.call.completed",
  "tc.acl.denied",
  "tc.elicit.requested",
  "tc.elicit.consumed",
  "tc.rate_limit.hit",
  "tc.governor.overflow",
  "tc.vault.cache_reset",
  "tc.server.start",
  "tc.server.shutdown",
  // THE-292 — additive: periodic cache.db maintenance sweep.
  "tc.maintenance.sweep",
] as const;

export const MorgianaEventType = z.enum(MORGIANA_EVENT_TYPES);
export type MorgianaEventType = z.infer<typeof MorgianaEventType>;

/**
 * The CloudEvents `data` payload (G2.4 §Data shape). One uniform shape across all event types:
 * tool-call events fill the rich fields; lifecycle/admin events fill only what applies. Bulk
 * operations emit ONE event per batch with `count` set (no per-row emission in hot loops).
 */
export const MorgianaEventDataSchema = z.object({
  vault_id: z.string(),
  tool: z.string().nullable().default(null),
  caller_hash: z.string().default("system"),
  scopes_required: z.array(z.string()).default([]),
  status: z.enum(["ok", "denied", "error"]).nullable().default(null),
  duration_ms: z.number().nullable().default(null),
  elicit_token: z.string().nullable().default(null),
  idempotency_key: z.string().nullable().default(null),
  result_size: z.number().nullable().default(null),
  overflow_bytes: z.number().nullable().default(null),
  error: z.object({ code: z.string(), message: z.string() }).nullable().default(null),
  count: z.number().nullable().default(null),
  /** THE-292 maintenance sweep: rows dropped per table. */
  rows_dropped: z.record(z.string(), z.number()).nullable().default(null),
});
export type MorgianaEventData = z.infer<typeof MorgianaEventDataSchema>;

/** CloudEvents 1.0 envelope (G2.4 §Envelope). `source` is `obsidian-tc/<vault_id>`. */
export const CloudEventSchema = z.object({
  specversion: z.literal("1.0"),
  id: z.string().min(1),
  source: z.string().min(1),
  type: MorgianaEventType,
  datacontenttype: z.literal("application/json").default("application/json"),
  time: z.string().min(1),
  data: MorgianaEventDataSchema,
});
export type CloudEvent = z.infer<typeof CloudEventSchema>;
