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
import { buildJwtVerifier } from "../auth/jwt-boot";
import { createOidcVerifier, type OidcVerifier } from "../auth/oidc";
import type { AuthRegistry } from "../auth/registry";
import { openAuthRegistry } from "../auth/registry-open";
import type { TokenVerifier } from "../auth/verifier";
import type { Database } from "../db/types";
import { type AdvisoryBus, createAdvisoryBus } from "../mcp/advisories";
import type { ToolRegistry } from "../mcp/registry";
import { type MetricsHandle, startMetricsEndpoint } from "../metrics/endpoint";
import type { MetricsRecorder } from "../metrics/registry";
import type { ProvenanceRecorder } from "../provenance/recorder";
import { registryKeyResolver, registrySignerSource } from "../provenance/signer";
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
  /** Signed write provenance recorder (absent when disabled). It gets its signing key here, from
   *  the auth registry opened below; with no registry or no EdDSA key it keeps writing unsigned. */
  provenance?: ProvenanceRecorder | undefined;
}

export interface TransportsWiring {
  /** THE-585 (#11): null until (and unless) the HTTP transport is constructed. */
  httpConstructSeconds: number | null;
  /** THE-634: publish side of the advisory push extension, constructed here (from
   *  `config.experiential.proactive.enabled`) so the ONE instance backing both the HTTP
   *  subscription endpoint and wireScheduler's sweep is built in one place. Absent when the flag
   *  is off — a caller threading this into wireScheduler must treat absence as "do not register". */
  advisoryBus?: AdvisoryBus;
  /** The auth registry opened for the bearer-checking listeners, when there is one. The scheduler's
   *  maintenance sweep reaps elapsed signing-key windows through it. */
  authRegistry?: AuthRegistry;
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

  // ONE registry (auth.db) for every bearer-checking listener, so the MCP edge and /metrics cannot
  // disagree about which tokens are revoked or which signing keys are live. Opened only when a
  // listener that checks bearers exists. A LOST registry (initialised before, auth.db now missing or
  // empty) is not an error at boot: the verifier refuses every bearer with the recovery named, and
  // the operator sees it here, in every rejection line and in `doctor`.
  // `oidc` needs it too: revocation by `jti` (and `auth.requireJti`) applies to an IdP's tokens through
  // the same tombstone registry, with the same fail-closed `registry_lost` semantics.
  const needsRegistry =
    (config.auth.mode === "jwt" || config.auth.mode === "oidc") &&
    (config.transports.http.enabled || config.observability.prometheus.enabled);
  // Server start is one of the three reaper triggers (rotate, start, periodic sweep): windows that
  // elapsed while nothing was running are persisted now. Housekeeping; verification never waits on it.
  const opened = needsRegistry ? await openAuthRegistry(config, { reapRetired: true }) : undefined;
  const authRegistry = opened?.registry;
  const registryHealth = authRegistry?.health();
  if (registryHealth?.state === "lost") {
    process.stderr.write(`auth: ERROR ${registryHealth.detail}\n`);
  }
  if (authRegistry !== undefined && config.auth.mode === "jwt") {
    // A jwt server whose only key source is the registry must HAVE a key there. The config no
    // longer demands auth.jwtSecret (it can be removed once the `config` key is retired), so this
    // is where a deployment with no key anywhere is refused at boot instead of running with every
    // bearer rejected.
    const { jwtSecret, jwks, jwksFile, jwksUri } = config.auth;
    const staticKey = !!jwtSecret || !!jwks || !!jwksFile || !!jwksUri;
    if (!staticKey && registryHealth?.state !== "lost") {
      const n = authRegistry.keyCounts();
      if (n.active + n.retiring === 0) {
        opened?.close();
        throw new Error(
          "auth.mode is 'jwt' but there is no signing key: set auth.jwtSecret (or OBSIDIAN_TC_JWT_SECRET), " +
            "configure a JWKS, or create a registry key with `obsidian-tc auth rotate-key`",
        );
      }
    }
    deps.metrics.bindAuthKeys(() => authRegistry.keyCounts());
  }

  if (authRegistry !== undefined && deps.provenance !== undefined) {
    // One line per process, not per write: a lost registry would otherwise repeat on every call.
    let warned = false;
    deps.provenance.setKeyResolverSource(() => registryKeyResolver(authRegistry.listKeys()));
    deps.provenance.setSignerSource(
      registrySignerSource(authRegistry, (e) => {
        if (warned) return;
        warned = true;
        const detail = e instanceof Error ? e.message : String(e);
        process.stderr.write(
          `[provenance] signing key unavailable, recording unsigned: ${detail}\n`,
        );
      }),
    );
  }

  try {
    // ONE bearer verifier for every listener that checks bearers. oidc: discover the identity
    // provider NOW (a failure throws, naming the issuer, and the server does not start). jwt: build
    // it from config (secret, inline/file/URI JWKS, registry keys). The MCP edge and /metrics are
    // handed this same instance, so they cannot disagree about which tokens are accepted.
    let oidcVerifier: OidcVerifier | undefined;
    if (
      config.auth.mode === "oidc" &&
      (config.transports.http.enabled || config.observability.prometheus.enabled)
    ) {
      oidcVerifier = await createOidcVerifier(config.auth, { registry: authRegistry });
      const d = oidcVerifier.describe();
      process.stderr.write(
        `auth: oidc verification only; issuer=${d.issuer} jwks_uri=${d.jwksUri} audience=${JSON.stringify(d.audience)} algs=${d.allowedAlgs.join(",")}\n`,
      );
    }
    const verifier: TokenVerifier | undefined =
      oidcVerifier ??
      (config.transports.http.enabled || config.observability.prometheus.enabled
        ? (buildJwtVerifier(config.auth, authRegistry) ?? undefined)
        : undefined);
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
        authRegistry,
        ...(verifier ? { verifier } : {}),
        vaultId: deps.firstVaultId,
        acl: deps.acl,
        host: config.transports.http.host,
        port: config.transports.http.port,
        facadeMode: config.toolFacade.mode,
        autoClients: config.toolFacade.autoClients,
        explainAutoMode: config.toolFacade.explainAutoMode,
        // GH #1027: resources/read takes no parameters, so the config default is its only selector.
        responseFormat: config.tools?.defaults?.responseFormat,
        // THE-1098 (GH #964): suppresses buildInstructions' record_retrieval_feedback clause when
        // there are no retrieval rows for feedback to update.
        experientialLogRetrievals: config.experiential.logRetrievals,
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
          config.vaults.find((v) => v.id === vaultId)?.workspace?.traceFolder ??
          DEFAULT_TRACE_FOLDER,
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
        ...(verifier ? { verifier } : {}),
        // The MCP route's Host-guard settings, so one operator list names the tunnel/proxy host.
        allowedHosts: config.transports.http.allowedHosts,
        enableDnsRebindingProtection: config.transports.http.enableDnsRebindingProtection,
      });
      metricsHandle = m;
      process.stderr.write(
        `obsidian-tc /metrics on ${config.observability.prometheus.bind}:${m.port}\n`,
      );
    }

    return {
      httpConstructSeconds,
      ...(advisoryBus ? { advisoryBus } : {}),
      ...(authRegistry ? { authRegistry } : {}),
      close: async () => {
        if (httpHandle) await httpHandle.close();
        if (metricsHandle) await metricsHandle.close();
        opened?.close();
      },
    };
  } catch (e) {
    opened?.close();
    throw e;
  }
}
