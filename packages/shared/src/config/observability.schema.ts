// WP1.6: extracted from ../config.schema.ts (which stays a compatibility facade re-exporting
// these same symbol names). Leaf schema — imports Zod only, no shared scalars needed here.
//
// Import direction is non-negotiable: this file must never import config.schema.ts,
// server.schema.ts, or any other schema module. All seven schemas below chain only
// `.prefault({})` (a default-application combinator, not a `.refine`/`.superRefine`) or nothing
// at all — there is no cross-domain field read to keep back in config.schema.ts, so all move
// here whole.
//
// The http/auth interlock (ServerConfigSchema.superRefine) is NOT here — it reads
// cfg.transports.http together with cfg.auth, which live in runtime.schema.ts and
// auth-acl.schema.ts respectively, so it is cross-domain and stays in config.schema.ts.
import { z } from "zod";

export const ObservabilityConfigSchema = z.object({
  // traceDetail / tracesSampleRate were declared here and read by NOTHING: no sampling was ever applied
  // and no detail switch existed. Removed rather than left as a lie in a schema operators trust. Re-add
  // them together with the code that honors them.
  otel: z
    .object({
      endpoint: z
        .string()
        .url()
        .optional()
        .describe("OTLP collector endpoint. OpenTelemetry export is a no-op until this is set."),
      headers: z
        .record(z.string(), z.string())
        .prefault({})
        .describe(
          "Extra headers sent with OTLP exports, e.g. an auth token. Values may be secret.",
        ),
    })
    .prefault({})
    .describe("OpenTelemetry trace export."),
  prometheus: z
    .object({
      enabled: z.boolean().default(false).describe("Serve the Prometheus /metrics endpoint."),
      port: z
        .number()
        .int()
        .min(0)
        .max(65535)
        .default(9464)
        .describe("Port for the Prometheus scrape endpoint."),
      bind: z
        .string()
        .default("127.0.0.1")
        .describe(
          "Bind address for the scrape endpoint. Loopback by default — /metrics is unauthenticated.",
        ),
    })
    .prefault({})
    .describe("Prometheus metrics endpoint."),
  morgiana: z
    .object({
      spool: z.boolean().default(true).describe("Write CloudEvents to a local JSONL spool file."),
      httpEndpoint: z
        .string()
        .url()
        .optional()
        .describe("Push CloudEvents to this URL. Absent means spool-only, with no network calls."),
      httpHeaders: z
        .record(z.string(), z.string())
        .prefault({})
        .describe("Extra headers sent with event pushes. Values may be secret."),
    })
    .prefault({})
    .describe("CloudEvents export stream."),
  retention: z
    .object({
      // morgianaEventsDays was declared and read by nothing and stays removed — the morgiana spool
      // still has no retention. tracesDays was removed for the same reason and is RE-ADDED here by
      // THE-610, which implemented the filesystem arm the original key was missing.
      eventLogDays: z
        .number()
        .int()
        .positive()
        .default(30)
        .describe(
          "Days of event_log rows kept by the maintenance sweep. The morgiana event spool is still not pruned and grows without bound.",
        ),
      tracesDays: z
        .number()
        .int()
        .positive()
        .default(30)
        .describe(
          "Days of workspace session trace files (<vault>/<traceFolder>/*.jsonl) kept by the maintenance sweep. Traces are per-vault and live INSIDE the vault, so they are also picked up by whatever syncs or backs it up. Orphans from a failed start_session are pruned by the same age rule (THE-572 writes the trace before the session row, so a failed attempt leaves a file with no row referencing it).",
        ),
    })
    .prefault({})
    .describe("Retention policy for locally stored observability data."),
});
// THE-374: point-in-time snapshot policy. When enabled, destructive note writes first capture
// the prior state (content-addressed) so restore_note can roll back; retention caps versions/note.
export const SnapshotsConfigSchema = z
  .object({
    enabled: z
      .boolean()
      .default(true)
      .describe(
        "Capture the prior content-addressed state before a destructive note write, so restore_note can roll back. On by default under the trusted-local posture; retention is pruned inline, so growth is bounded.",
      ),
    retention: z
      .number()
      .int()
      .positive()
      .max(1000)
      .default(10)
      .describe("Maximum snapshot versions kept per note. Older versions are pruned."),
  })
  .prefault({});
// THE-292 — periodic cache.db maintenance sweep (expired idempotency/elicit rows + event_log
// retention + PRAGMA optimize). Fully defaulted: a config predating it validates unchanged.
export const MaintenanceConfigSchema = z
  .object({
    enabled: z
      .boolean()
      .default(true)
      .describe(
        "Run the periodic cache.db maintenance sweep (expired idempotency and elicitation rows, event_log retention, PRAGMA optimize).",
      ),
    intervalMinutes: z
      .number()
      .int()
      .positive()
      .default(60)
      .describe("Minutes between maintenance sweeps."),
    // THE-571: the durable queue never pruned finished rows, so `jobs` grew without bound. Only
    // TERMINAL rows are swept -- queued/running/retrying are live work regardless of age.
    jobsCompleteRetentionDays: z
      .number()
      .int()
      .positive()
      .default(7)
      .describe(
        "Days a COMPLETE job row is retained before the maintenance sweep prunes it. Must stay LONGER than the longest producer dedup window: enqueue() dedups against a terminal row unless replaceIfTerminal is set, so pruning one frees its idempotency key and lets that period run again (the weekly synthesis is the longest today).",
      ),
    // THE-610 arm 2: the experiential store's two growth curves. Only DEAD episodes (forget
    // tombstones and bi-temporally expired rows) are ever pruned — a live episode is work memory
    // and age says nothing about whether it is finished with.
    // THE-458 item 6: a PERIODIC vault reconcile. Off unless set, because a server whose watcher
    // is healthy does not need it — but two gaps opened when THE-649 made the watcher the primary
    // change source, and this is the only thing that closes either short of a manual index_vault:
    //   * the watcher is not started on Windows at all, can fail to arm (inotify ENOSPC), sees
    //     nothing on some network mounts, and never covers vaults added later by add_vault;
    //   * indexNote does NOT densify, so the watcher's single-note writes leave derived edges
    //     stale until a full pass runs. This pass threads densify exactly as the boot one does.
    reconcileIntervalMinutes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Minutes between periodic full vault reconciles. ABSENT (the default) disables it: the boot reconcile and the filesystem watch already cover a healthy server. Set it when the watch cannot run — Windows (where it is never started), a network mount with no change notification, or a vault large enough to exhaust the inotify limit — and when derived graph edges should be refreshed, since single-note writes never densify. Costs a full vault walk per run; content-hash skip makes an unchanged vault cheap to re-walk but densification still runs.",
      ),
    episodesRetentionDays: z
      .number()
      .int()
      .positive()
      .default(90)
      .describe(
        "Days a DEAD agent_episodes row (a forget tombstone, or one whose valid_until has passed) is retained before the maintenance sweep prunes it. Live episodes are never pruned at any age. Keep this long enough to still answer 'was this forgotten?' after the fact.",
      ),
    retrievalsRetentionDays: z
      .number()
      .int()
      .positive()
      .default(365)
      .describe(
        "Days a chunk_retrievals row is retained. NOT purely disk hygiene: chunk_access_stats is a VIEW over this table, so pruning REWRITES access_count / last_accessed_at / citations / outcome_balance, which feed activation and note quality. A short window makes a long-tail note that was genuinely useful look never-accessed. The default is deliberately a year, far above the other retention windows, so no signal any current consumer reads is affected.",
      ),
    jobsFailedRetentionDays: z
      .number()
      .int()
      .positive()
      .default(30)
      .describe(
        "Days a FAILED (dead-lettered) job row is retained. Longer than the complete-row window because these exist to be read; bounded by age, so a burst of failures inside the window is still unbounded in count.",
      ),
  })
  .prefault({});

// THE-649 — filesystem watch over each vault root. Fully defaulted, and defaulted ON: docs/SYNC.md
// has described this behaviour ("the server watches vaultPath and reindexes changed files") since
// before the watcher existed, so ON is the setting that makes the documented contract true rather
// than a new opt-in feature. Every sync tier in that document delivers Markdown by writing to disk,
// which is the only event this can observe.
export const WatchConfigSchema = z
  .object({
    enabled: z
      .boolean()
      .default(true)
      .describe(
        "Watch each vault root and reindex notes changed outside the server (sync clients, git pull, an editor on the host). Not active on Windows regardless of this setting: Node's recursive fs.watch terminated the test process there, and whether a long-lived server is affected the same way is unverified. Turn OFF for a vault on a filesystem with no usable change notification (some network mounts) or to cap inotify usage on a very large vault; index_vault then remains the only way changes are picked up.",
      ),
    debounceMs: z
      .number()
      .int()
      .positive()
      .default(500)
      .describe(
        "Quiet period before a burst of filesystem events is flushed. One editor save emits several events and a sync pass emits one per file; this coalesces both into a single reindex per path. Raising it delays pickup, lowering it costs redundant reindex passes during a large sync.",
      ),
  })
  .prefault({});

// THE-458 item 6 — the shared background scheduler. One key today, and it exists because the
// feature behind it was built, tested and then unreachable: `eventLoopDeferMs` gates budget
// deferral (a due tick waits instead of piling onto a loop that is already behind), and cli.ts
// simply never passed it. `scheduler_deferred_total` was therefore pinned at 0 for every release
// since it shipped — the metric's own description says as much, honestly, which made it easy to
// read as "nothing to defer" rather than "no way to turn it on".
//
// Still DEFAULTED OFF (absent), so cadence is unchanged for every existing deployment. The change
// is that an operator can now reach it without editing source.
export const SchedulerConfigSchema = z
  .object({
    eventLoopDeferMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Event-loop delay p99 (ms) above which a DUE background tick is deferred rather than run. Deferred is not skipped: the tick runs on a later pass once the loop recovers, and obsidian_tc_scheduler_deferred_total counts it. Absent (the default) disables deferral entirely and the event-loop monitor is never even created, so there is no cost when off. Set it when background work is observably competing with request latency; a value near your acceptable p99 tail is the starting point.",
      ),
  })
  .prefault({});

// THE-296 — ambient sleep-time consolidation (synthesis + audit jobs). Fully defaulted; only
// meaningful when the inference gateway (roles) is configured — cli gates on both.
export const PlaneConfigSchema = z
  .object({
    enabled: z
      .boolean()
      .default(true)
      .describe(
        "Run ambient sleep-time consolidation (synthesis and audit jobs). Only meaningful when the inference gateway roles are configured.",
      ),
    intervalMinutes: z
      .number()
      .int()
      .positive()
      .default(240)
      .describe("Minutes between consolidation passes."),
  })
  .prefault({});

// plur read-API proxy config (M5 / THE-181, G2.1 Domain 24). GLOBAL, not per-vault:
// the plur engram store is global and the plur tools take no `vault` argument, so
// this lives at the server root. endpoint/apiKey come from config or the
// OBSIDIAN_TC_PLUR_ENDPOINT / OBSIDIAN_TC_PLUR_TOKEN env vars (resolved in
// config/load.ts); the bearer is placed solely in the Authorization header by the
// bridge transport — never logged, never in an error/audit payload. Optional with
// inner defaults: when `endpoint` is absent the plur tools degrade to plugin_missing
// with NO network call.
export const PlurConfigSchema = z.object({
  endpoint: z
    .string()
    .url()
    .optional()
    .describe(
      "Base URL of the plur read API. When absent (and no `command` is set) the plur tools degrade to plugin_missing with NO network call.",
    ),
  apiKey: z
    .string()
    .optional()
    .describe(
      "Bearer token for the plur read API. Secret — placed only in the Authorization header, never logged or included in an error or audit payload.",
    ),
  apiPrefix: z.string().default("").describe("Path prefix prepended to plur API routes."),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .default(5000)
    .describe("Timeout in ms for a plur read call."),
  // THE-208: local plur bridge. plur ships no HTTP read-API (CLI + stdio-MCP + a local YAML
  // store); when `command` is set the plur read tools shell out to the local plur CLI instead
  // of the (Enterprise-only) HTTP endpoint. argv prefix, e.g. ["plur"] or
  // ["node", "/abs/@plur-ai/cli/dist/index.js"]. Takes precedence over `endpoint`.
  command: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .describe(
      'argv prefix for shelling out to a local plur CLI instead of the HTTP endpoint, e.g. ["plur"]. Takes precedence over `endpoint`.',
    ),
});
