// WP1.5: extracted from ../config.schema.ts (which stays a compatibility facade re-exporting
// these same symbol names). Leaf schema — imports Zod only, no shared scalars needed here.
//
// Import direction is non-negotiable: this file must never import config.schema.ts,
// server.schema.ts, or any other schema module. ThrottleConfigSchema and WritesConfigSchema
// each chain only `.prefault({})` (a default-application combinator, not a `.refine`/
// `.superRefine`) — there is no cross-domain field read to keep back in config.schema.ts, so both
// move here whole.
//
// The http/auth interlock (ServerConfigSchema.superRefine reading cfg.transports.http together
// with cfg.auth) is NOT here — it is cross-domain and stays in config.schema.ts even though
// HttpConfigSchema/TransportsConfigSchema move.
import { z } from "zod";

export const HttpConfigSchema = z.object({
  enabled: z.boolean().default(false).describe("Serve the MCP HTTP transport."),
  host: z
    .string()
    .default("127.0.0.1")
    .describe(
      "Bind address. A non-loopback host is refused while auth.mode is `none`, since every request would otherwise resolve to full wildcard scopes.",
    ),
  port: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(8765)
    .describe("TCP port for the HTTP transport."),
  // DNS-rebinding / cross-origin protection (THE-271). On by default: reject a request whose Host is
  // neither loopback nor operator-allowed, or whose Origin (browsers always send one) is not the same
  // origin or operator-allowed. Server-to-server clients send no Origin and are unaffected.
  enableDnsRebindingProtection: z
    .boolean()
    .default(true)
    .describe(
      "Reject a request whose Host is neither loopback nor operator-allowed, or whose Origin is neither same-origin nor operator-allowed. Server-to-server clients send no Origin and are unaffected.",
    ),
  allowedHosts: z
    .array(z.string())
    .default([])
    .describe("Additional Host header values accepted by the rebinding guard."),
  allowedOrigins: z
    .array(z.string())
    .default([])
    .describe("Additional Origin header values accepted by the rebinding guard."),
});

export const TransportsConfigSchema = z.object({
  stdio: z.boolean().default(true).describe("Serve the MCP stdio transport."),
  http: HttpConfigSchema.prefault({}).describe("HTTP transport settings."),
});

export const GovernorConfigSchema = z.object({
  maxResponseBytes: z
    .number()
    .int()
    .positive()
    .default(1_000_000)
    .describe(
      "Ceiling on a single tool or resource response in bytes, before it is refused (THE-514: resources/read honors this too, not just tools).",
    ),
  // THE-293: worker-time budget (ms) for one search_regex / search_vault(mode:regex) call.
  // Only regex execution in the worker counts — file I/O does not — so a benign pattern on a
  // large vault cannot false-positive the ReDoS guard.
  regexTimeoutMs: z
    .number()
    .int()
    .positive()
    .default(2000)
    .describe(
      "Worker-time budget in ms for one regex search. Only regex execution counts — file I/O does not — so a benign pattern over a large vault cannot false-positive the ReDoS guard.",
    ),
});

// Per-scope-class throttle tiers + write-concurrency ceiling (THE-182 / M6, G2.4
// §Rate limits). Additive + fully defaulted, so a config predating M6 validates
// unchanged. The M6 bulk tools enforce the `bulk` tier (10/min, burst 3); the
// other tiers are reported by get_server_config and reserved for the M7
// dispatch-wide rate-limit gate. get_server_config surfaces these as its `limits`
// block (non-secret).
const throttleTier = (kind: string, perMinute: number, burst: number) =>
  z
    .object({
      perMinute: z
        .number()
        .int()
        .positive()
        .default(perMinute)
        .describe(`Sustained ${kind}-scope calls allowed per minute.`),
      burst: z
        .number()
        .int()
        .positive()
        .default(burst)
        .describe(
          `Bucket depth for ${kind}-scope calls: how many may fire back-to-back before the per-minute rate applies.`,
        ),
    })
    .prefault({})
    .describe(`Throttle tier for ${kind}-scope tools.`);

export const ThrottleConfigSchema = z
  .object({
    enabled: z.boolean().default(true).describe("Enforce per-scope-class rate limits."),
    tiers: z
      .object({
        read: throttleTier("read", 600, 100),
        write: throttleTier("write", 60, 20),
        delete: throttleTier("delete", 60, 20),
        bulk: throttleTier("bulk", 10, 3),
        execute: throttleTier("execute", 5, 1),
        admin: throttleTier("admin", 5, 1),
      })
      .prefault({})
      .describe("Per-scope-class rate limits."),
    maxConcurrentWritesPerVault: z
      .number()
      .int()
      .positive()
      .default(16)
      .describe("Ceiling on concurrent write operations against a single vault."),
  })
  .prefault({});
export type ThrottleConfig = z.infer<typeof ThrottleConfigSchema>;

// THE-252: write-safety policy. requireCas gates compare-and-swap on the destructive write paths.
export const WritesConfigSchema = z
  .object({
    // When true, write_note (overwrite) and append_note to an existing note REQUIRE a prev_hash
    // (compare-and-swap) and fail closed with invalid_input when it is absent, so a stale or absent
    // hash cannot silently clobber. Default off; the non-configurable hard default is deferred to a major.
    requireCas: z
      .boolean()
      .default(false)
      .describe(
        "Require a prev_hash (compare-and-swap) on overwriting writes and on appends to an existing note, failing closed with invalid_input when absent so a stale hash cannot silently clobber.",
      ),
  })
  .prefault({});

// THE-726: server-opened workspace sessions.
//
// `workspace_sessions` stayed empty not because the mechanism was broken but because opening a
// session is a DELIBERATE act and no client performs it. #691/#692 made the HTTP transport able to
// carry a session; this decides whether the server also *creates* one. Default OFF — the epic's
// constraint 4 makes privacy a design input, not a follow-up, and session correlation changes what
// this server retains about who read what.
//
// The unit is a WINDOW, not an idle timeout, and the difference is deliberate. A true idle timeout
// needs a `last_activity_at` column and a write on (or throttled across) every request; a window
// needs neither — an auto-opened session is closed by the maintenance sweep once it is older than
// `windowSeconds`, and the next request opens a fresh one. A task spanning a boundary therefore
// splits across two sessions, which costs a little correlation and buys no new column, no new
// migration, and no write in the read path. Revisit only with a measured need.
//
// `windowSeconds` is consequently a FLOOR on the lifetime, not the lifetime. Closing is the sweep's
// job and the sweep has its own cadence, so a session survives until the first sweep that runs
// after it ages out — up to `maintenance.intervalMinutes` later. Measured in production on the
// 1.19.0 rollout: a session created at 12:34 was still open and still correlating at 13:21, because
// the sweep had last run at 12:27 and was not due again until 13:27. That is the design working,
// and it is why the description below says eligible-to-close rather than closed.
export const SessionsConfigSchema = z
  .object({
    autoOpen: z
      .boolean()
      .default(false)
      .describe(
        "Open a workspace session automatically on a principal's first authenticated dispatch when it has none, instead of waiting for an explicit start_session. Off by default: session correlation changes what the server retains about who read what.",
      ),
    windowSeconds: z
      .number()
      .int()
      .positive()
      .default(1800)
      .describe(
        "How long a server-opened session keeps correlating before it becomes ELIGIBLE to be closed. This is a floor, not an exact lifetime: the closing is done by the maintenance sweep on ITS schedule (maintenance.intervalMinutes, default 60), so a session actually lives between windowSeconds and windowSeconds + that interval — with both defaults, between 30 and 90 minutes. A session is a bounded activity window, not an idle timeout: it is closed on age, never on inactivity, and the next request opens a fresh one. Explicit start_session sessions are never closed by the sweep — only end_session closes those.",
      ),
  })
  .prefault({});
