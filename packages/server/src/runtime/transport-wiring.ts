// WP5.2 (issue 16): run_serve's HTTP + Prometheus /metrics transport wiring, extracted verbatim
// out of cli.ts. THE-585 (#11): the HTTP transport's construction time is timed here (the perf
// harness measures this as `http.cold_ms` on a synthetic vault) and reported back through
// `httpConstructSeconds` so observability.ts's lazy gauge source can read it.
//
// Neither transport had an explicit close() before this slice — shutdown relied on process.exit(0)
// tearing the sockets down. `close()` below gives both a real owner and an idempotent cleanup (the
// map's WP5 acceptance criterion), closing whichever of the two were actually opened; a transport
// that was never enabled contributes nothing to unwind, mirroring server-runtime.ts's
// unwindReversed pattern for the boot-time layers.
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import type { FolderAcl } from "../acl";
import type { Database } from "../db/types";
import { type AdvisoryBus, createAdvisoryBus } from "../mcp/advisories";
import type { ToolRegistry } from "../mcp/registry";
import { type MetricsHandle, startMetricsEndpoint } from "../metrics/endpoint";
import type { MetricsRecorder } from "../metrics/registry";
import type { JobQueue } from "../scheduler/job-queue";
import { type HttpHandle, startHttp } from "../transports/http";
import type { VaultRegistry } from "../vault/registry";
import { DEFAULT_TRACE_FOLDER } from "../workspace/sessions";

export interface TransportWiringDeps {
  config: ServerConfig;
  version: string;
  registry: ToolRegistry;
  vaultRegistry: VaultRegistry;
  db: Database;
  firstVaultId: string;
  acl: FolderAcl;
  jobQueue: JobQueue;
  metrics: MetricsRecorder;
}

export interface TransportsWiring {
  /** THE-585 (#11): null until (and unless) the HTTP transport is constructed. */
  httpConstructSeconds: number | null;
  /** THE-634: publish side of the advisory push extension, constructed here (from
   *  `config.experiential.proactive.enabled`) so the ONE instance backing both the HTTP
   *  subscription endpoint and wireScheduler's sweep is built in one place. Absent when the flag
   *  is off — a caller threading this into wireScheduler must treat absence as "do not register". */
  advisoryBus?: AdvisoryBus;
  /** Idempotent: closes whichever of HTTP/metrics were actually opened; a no-op transport
   *  contributes nothing. Safe to call more than once (each handle's own close() is awaited only
   *  the first time — see server-runtime.ts's close(), which guards the whole shutdown sequence). */
  close(): Promise<void>;
}

/**
 * Bind the MCP HTTP transport (config.transports.http.enabled) and the Prometheus /metrics
 * endpoint (config.observability.prometheus.enabled), each only when configured.
 */
export async function wireTransports(deps: TransportWiringDeps): Promise<TransportsWiring> {
  const { config } = deps;
  let httpConstructSeconds: number | null = null;
  let httpHandle: HttpHandle | undefined;
  let metricsHandle: MetricsHandle | undefined;
  // THE-634: gated on the flag alone (not experientialOpen too) — a bus with no scheduler feeding
  // it is inert, not wrong; wireScheduler's own registration is what actually needs both.
  const advisoryBus = config.experiential.proactive.enabled ? createAdvisoryBus() : undefined;

  if (config.transports.http.enabled) {
    // THE-585 (#11): time the transport's construction + bind.
    const httpT0 = performance.now();
    const http = await startHttp({
      name: "obsidian-tc",
      version: deps.version,
      registry: deps.registry,
      vaultRegistry: deps.vaultRegistry,
      auth: config.auth,
      db: deps.db,
      vaultId: deps.firstVaultId,
      acl: deps.acl,
      host: config.transports.http.host,
      port: config.transports.http.port,
      facadeMode: config.toolFacade.mode,
      jobQueue: deps.jobQueue,
      ...(advisoryBus ? { advisoryBus } : {}),
      enableDnsRebindingProtection: config.transports.http.enableDnsRebindingProtection,
      allowedHosts: config.transports.http.allowedHosts,
      allowedOrigins: config.transports.http.allowedOrigins,
      // THE-520: without this the auth_rejections_total counter exists but is never incremented.
      metrics: deps.metrics,
      // THE-726: server-opened sessions. Threaded here rather than read inside the transport so the
      // transport stays a function of its options — and so `sessions.autoOpen: false` (the default)
      // reaches it as an explicit false rather than as an absent key nobody wired.
      sessions: config.sessions,
      traceFolderFor: (vaultId) =>
        config.vaults.find((v) => v.id === vaultId)?.workspace?.traceFolder ?? DEFAULT_TRACE_FOLDER,
      // THE-647 item 2: named persona bundles a JWT `persona` claim resolves to. Absent (the
      // default) means no persona claim can ever resolve — unchanged behaviour for every
      // deployment that does not configure this block.
      personas: config.personas,
    });
    httpConstructSeconds = (performance.now() - httpT0) / 1000;
    httpHandle = http;
    process.stderr.write(
      `obsidian-tc http listening on ${config.transports.http.host}:${http.port}\n`,
    );
  }

  if (config.observability.prometheus.enabled) {
    const m = await startMetricsEndpoint({
      recorder: deps.metrics,
      bind: config.observability.prometheus.bind,
      port: config.observability.prometheus.port,
      auth: config.auth,
    });
    metricsHandle = m;
    process.stderr.write(
      `obsidian-tc /metrics on ${config.observability.prometheus.bind}:${m.port}\n`,
    );
  }

  return {
    httpConstructSeconds,
    ...(advisoryBus ? { advisoryBus } : {}),
    close: async () => {
      if (httpHandle) await httpHandle.close();
      if (metricsHandle) await metricsHandle.close();
    },
  };
}
