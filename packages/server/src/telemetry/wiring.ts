// THE-1125 — composition root for opt-in telemetry: builds the collector, adapts it to the
// narrow `ToolCallObserver` interface `MetricsRecorder` takes, registers the scheduler job (only
// when `config.telemetry.enabled`), and exposes the read accessors `doctor`/`server_health`/the
// `telemetry status`/`preview` CLI commands need. Mirrors runtime/observability.ts's own seam
// shape (a plain object of callbacks the rest of the server takes instead of importing this
// module directly) so telemetry stays optional dead weight on a build that never enables it.
import { randomUUID } from "node:crypto";
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import type { Database } from "../db/types";
// THE-1125 fix round: imported from known-clients.ts, NOT facade-auto.ts — facade-auto.ts already
// imports TelemetryStatusInfo (type-only) from THIS file, so importing back from facade-auto.ts
// would be a real module-graph cycle (check:boundaries' no-circular catches type-only edges too).
import { BUILTIN_AUTO_FACADE_CLIENTS } from "../mcp/known-clients";
import type { ToolCallObserver, ToolCallStatus } from "../metrics/registry";
import type { Scheduler } from "../scheduler/scheduler";
import { TelemetryCollector } from "./collector";
import { buildTelemetryDocument, type TelemetryDocument } from "./document";
import { redactEndpoint } from "./redact-endpoint";
import { sendTelemetry } from "./sender";
import { readTelemetryState } from "./state";

export interface TelemetryStatusInfo {
  enabled: boolean;
  /** Redacted (redact-endpoint.ts: scheme + host ONLY, never the path) — never the raw configured
   *  URL, whose userinfo, query string, or path may carry a collector API key. */
  endpoint?: string;
  installId?: string;
  lastSendAt?: number;
  lastError?: string;
  nextSendAt?: number;
}

export interface TelemetryWiring {
  observer: ToolCallObserver;
  /** Register the send job on `scheduler`. No-ops (registers nothing) when
   *  `config.telemetry.enabled` is false — matches every other conditional job in
   *  scheduler-wiring.ts (registerGapSweep, registerAdvisorySweep, vault-reconcile). */
  registerJob: (scheduler: Scheduler) => void;
  /** `doctor`/`server_health`'s `telemetry` field. */
  getStatus: () => TelemetryStatusInfo;
  /** `obsidian-tc telemetry preview`: the document that would be sent RIGHT NOW — built directly,
   *  never through `sendTelemetry`, so preview makes NO network call and never resets the
   *  collector's window (only a successful send does that). */
  previewDocument: () => TelemetryDocument;
}

const TELEMETRY_JOB_NAME = "telemetry-send";

/** `config.toolFacade.mode`, collapsed to a concrete FacadeMode for telemetry's own fallback:
 *  "auto" resolves per-connection (mcp/facade-mode-resolver.ts), which this static read cannot
 *  see, so it reports the SAME fallback that resolver itself uses for an unmatched client
 *  ("triad" — mcp/facade-auto.ts's FALLBACK_FACADE_MODE) rather than importing that module here
 *  just to re-spell the literal. */
export function defaultConfiguredFacadeMode(
  config: Pick<ServerConfig, "toolFacade">,
): "triad" | "domain" | "flat" {
  return config.toolFacade.mode === "auto" ? "triad" : config.toolFacade.mode;
}

export interface TelemetryWiringDeps {
  config: ServerConfig;
  db: Database;
  serverVersion: string;
  /** The facade mode reported until this process's first tool call — after that, the collector
   *  reports the mode `ctx.effectiveFacadeMode` most recently resolved to (a per-CONNECTION value,
   *  since THE-1123's `toolFacade.mode: "auto"` can differ per client). Defaults to
   *  `defaultConfiguredFacadeMode(config)`; a test seam may override. */
  getConfiguredFacadeMode?: () => "triad" | "domain" | "flat";
  /** Security review (grok HIGH-1): the registered tool names `TelemetryCollector` allowlists
   *  `toolCalls` keys against — read LIVE (the registry is constructed after telemetry itself in
   *  server-runtime.ts's boot order; see that file's lazy-ref pattern). Defaults to an
   *  always-empty set, which is safe (everything buckets to `unknown`) for a caller with no live
   *  registry (the CLI `telemetry preview`/`status` commands, or a bare unit test). */
  getKnownToolNames?: () => ReadonlySet<string>;
  now?: () => number;
}

/** Build the telemetry collector + its scheduler/doctor/CLI seams. Cheap to call even when
 *  telemetry is disabled — the collector still counts (so `telemetry preview` reports real numbers
 *  even with `enabled: false`, per the ticket), it simply never gets a scheduler job or makes a
 *  network call. */
export function wireTelemetry(deps: TelemetryWiringDeps): TelemetryWiring {
  const now = deps.now ?? Date.now;
  const collector = new TelemetryCollector(deps.getKnownToolNames, now);
  let lastFacadeMode: "triad" | "domain" | "flat" = (
    deps.getConfiguredFacadeMode ?? (() => defaultConfiguredFacadeMode(deps.config))
  )();

  const observer: ToolCallObserver = {
    onToolCall(
      tool: string,
      _status: ToolCallStatus,
      detail?: { errorCode?: string; facadeMode?: string; clientName?: string },
    ) {
      collector.recordToolCall(tool, detail?.errorCode);
      collector.recordClientName(detail?.clientName, BUILTIN_AUTO_FACADE_CLIENTS);
      if (
        detail?.facadeMode === "triad" ||
        detail?.facadeMode === "domain" ||
        detail?.facadeMode === "flat"
      ) {
        lastFacadeMode = detail.facadeMode;
      }
    },
  };

  return {
    observer,
    registerJob(scheduler: Scheduler) {
      if (!deps.config.telemetry.enabled) return;
      const endpoint = deps.config.telemetry.endpoint;
      if (endpoint === undefined) return; // unreachable given config validation; defensive.
      scheduler.register({
        name: TELEMETRY_JOB_NAME,
        intervalMs: deps.config.telemetry.intervalMinutes * 60_000,
        run: async () => {
          await sendTelemetry({
            db: deps.db,
            collector,
            endpoint,
            ...(deps.config.telemetry.authTokenEnv !== undefined
              ? { authTokenEnv: deps.config.telemetry.authTokenEnv }
              : {}),
            serverVersion: deps.serverVersion,
            facadeMode: lastFacadeMode,
            now,
          });
        },
      });
    },
    getStatus(): TelemetryStatusInfo {
      const state = readTelemetryState(deps.db);
      const endpoint = deps.config.telemetry.endpoint;
      return {
        enabled: deps.config.telemetry.enabled,
        ...(endpoint !== undefined ? { endpoint: redactEndpoint(endpoint) } : {}),
        ...(state?.installId !== undefined ? { installId: state.installId } : {}),
        ...(state?.lastSendAt != null ? { lastSendAt: state.lastSendAt } : {}),
        ...(state?.lastError != null ? { lastError: state.lastError } : {}),
        ...(deps.config.telemetry.enabled && state?.lastSendAt != null
          ? { nextSendAt: state.lastSendAt + deps.config.telemetry.intervalMinutes * 60_000 }
          : {}),
      };
    },
    previewDocument(): TelemetryDocument {
      // Security review (in-pool, LOW-H): the install id is created on first ENABLED send
      // (sendTelemetry's own getOrCreateInstallId call), never as a side effect of a preview read
      // — a disabled config that is merely being inspected must not seed durable state. When no
      // row exists yet, show an EPHEMERAL id (never persisted) so the document's shape is still
      // demonstrable; when a real one already exists (this install has sent, or enabled it
      // before), show that one.
      const installId = readTelemetryState(deps.db)?.installId ?? randomUUID();
      const snap = collector.snapshot(now);
      return buildTelemetryDocument({
        installId,
        serverVersion: deps.serverVersion,
        os: process.platform,
        arch: process.arch,
        facadeMode: lastFacadeMode,
        clientNames: snap.clientNames,
        toolCalls: snap.toolCalls,
        errorCodes: snap.errorCodes,
        windowStart: snap.windowStart,
        windowEnd: snap.windowEnd,
      });
    },
  };
}
