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
import { configuredJwksOverlap, ensureAsKey } from "../auth/as-boot";
import { drainRevocations } from "../auth/as-grants";
import { enabledAs } from "../auth/as-metadata";
import { assertArgon2Runtime } from "../auth/as-password";
import { describeJwksTarget, jwksModeLine } from "../auth/jwks-network";
import { buildJwtVerifier, warnJwksWithoutAudience } from "../auth/jwt-boot";
import { gcOauthDb, isClaimed, type OpenedOauthDb, openOauthDb } from "../auth/oauth-db";
import { createOidcVerifier, type OidcVerifier, oidcBootNotice } from "../auth/oidc";
import type { AuthRegistry } from "../auth/registry";
import { openAuthRegistry } from "../auth/registry-open";
import type { TokenVerifier } from "../auth/verifier";
import type { Database } from "../db/types";
import { providerResolveHost } from "../gateway/provider-fetch";
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
  /** Starts a queued task call now; see `McpServerOptions.startTask`. */
  startTask: (jobId: string) => void;
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
  /** oauth.db housekeeping (`gcOauthDb`) over the authorization server's own store, present only
   *  while `auth.as` is enabled. The maintenance sweep runs it; `close()` releases the handle. */
  reapOauthDb?: () => number;
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
  let oauthDb: OpenedOauthDb | undefined;
  let reapOauthDb: (() => number) | undefined;
  if (registryHealth?.state === "lost") {
    process.stderr.write(`auth: ERROR ${registryHealth.detail}\n`);
  }
  const as = enabledAs(config.auth);
  if (authRegistry !== undefined && as !== undefined && config.auth.mode === "jwt") {
    // The `as` key is generated BEFORE the no-signing-key refusal below, so an AS-only deployment
    // (no jwtSecret, no JWKS, no `mint` key) boots with the key it issues tokens with. With the AS
    // off nothing is generated here and that refusal judges the deployment exactly as before.
    try {
      // A configured JWKS key is verified under the hand-minted-token rules, so an `as` key listed
      // there would skip the `as` rules: refuse the boot. A remote `auth.jwksUri` cannot be checked.
      const dup = await configuredJwksOverlap(config.auth, authRegistry);
      if (dup !== undefined) {
        throw new Error(
          `${dup.source} contains the public key of the authorization server's signing key ${dup.kids.join(", ")}: ` +
            `remove it from ${dup.source} (the server publishes its own key at ${as.issuer}/.well-known/jwks.json)`,
        );
      }
      const key = await ensureAsKey(authRegistry, {
        alg: as.signingAlg,
        accessTokenSeconds: as.accessTokenSeconds,
      });
      if (key.created) {
        process.stderr.write(`auth: generated the authorization server signing key ${key.kid}\n`);
      } else if (key.skipped === "alg_mismatch") {
        process.stderr.write(
          `auth: WARNING the active authorization server key ${key.kid} is ${key.existingAlg} but auth.as.signingAlg is ${as.signingAlg}; ` +
            "rotate it with `obsidian-tc auth rotate-key --purpose as` to switch\n",
        );
      }
    } catch (e) {
      opened?.close();
      throw e;
    }
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
    if (authRegistry !== undefined && as !== undefined && config.auth.mode === "jwt") {
      // Passwords are Argon2id: a runtime without crypto.argon2 (Node 24.0 to 24.6) refuses the
      // boot here, not at the first login.
      assertArgon2Runtime();
      oauthDb = await openOauthDb(config);
      const store = oauthDb;
      if (!isClaimed(store.db)) {
        const viaPage = (process.env[as.setupTokenEnv] ?? "") !== "";
        process.stderr.write(
          "auth: the authorization server is not claimed: it refuses authorize, token and register until " +
            `the operator claims it with \`obsidian-tc auth as set-password\` on this host${viaPage ? `, or at ${as.issuer}/oauth/setup with the setup token` : ""}\n`,
        );
      }
      const registry = authRegistry;
      // The revocations a crash or a busy auth.db left owed (`revocation_outbox`) are paid first, at boot
      // and on every sweep; a registry that still cannot take them is reported, never fatal here.
      reapOauthDb = () => {
        try {
          drainRevocations(store.db, registry);
        } catch (e) {
          process.stderr.write(
            `[as] revocations not yet recorded in the registry: ${e instanceof Error ? e.message : String(e)}\n`,
          );
        }
        return gcOauthDb(store.db, { now: Date.now(), dcrUnusedDays: as.dcr.unusedDays }).total;
      };
      reapOauthDb();
    }
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
      process.stderr.write(oidcBootNotice(d));
    }
    const listensForBearers =
      config.transports.http.enabled || config.observability.prometheus.enabled;
    const verifier: TokenVerifier | undefined =
      oidcVerifier ??
      (listensForBearers ? (buildJwtVerifier(config.auth, authRegistry) ?? undefined) : undefined);
    // buildJwtVerifier says it when it runs; a stdio-only boot never builds one, but the config is
    // the same and the operator should hear it.
    if (!listensForBearers) warnJwksWithoutAudience(config.auth);
    if (verifier !== undefined && oidcVerifier === undefined && config.auth.jwksUri !== undefined) {
      // One line saying how the remote key set is fetched (pinned public, loopback, listed, or the
      // deprecated unlisted private host), from the decision the fetch itself applies. Advisory: a
      // DNS hiccup here must not stop the server, the fetch decides again per request.
      const jwks = await describeJwksTarget(config.auth.jwksUri, {
        plainHttpHosts: config.network.plainHttpHosts,
        resolveHost: (host) =>
          Promise.race([
            providerResolveHost(host),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("DNS lookup timed out")), 3_000).unref(),
            ),
          ]),
      });
      process.stderr.write(`auth: jwt ${jwksModeLine(jwks)}\n`);
    }
    if (config.transports.http.enabled) {
      // THE-585 (#11): time the transport's construction + bind.
      const httpT0 = performance.now();
      const http = await startHttp({
        name: "obsidian-tc",
        version: deps.version,
        registry: deps.registry,
        vaultRegistry: deps.vaultRegistry,
        auth: config.auth,
        cacheDir: config.cacheDir,
        db: deps.db,
        authRegistry,
        ...(oauthDb ? { oauthDb: oauthDb.db } : {}),
        ...(verifier ? { verifier } : {}),
        vaultId: deps.firstVaultId,
        acl: deps.acl,
        host: config.transports.http.host,
        port: config.transports.http.port,
        facadeMode: config.toolFacade.mode,
        autoClients: config.toolFacade.autoClients,
        explainAutoMode: config.toolFacade.explainAutoMode,
        outputSchema: config.toolFacade.outputSchema,
        advertise: config.toolFacade.advertise,
        // GH #1027: resources/read takes no parameters, so the config default is its only selector.
        responseFormat: config.tools?.defaults?.responseFormat,
        // THE-1098 (GH #964): suppresses buildInstructions' record_retrieval_feedback clause when
        // there are no retrieval rows for feedback to update.
        experientialLogRetrievals: config.experiential.logRetrievals,
        jobQueue: deps.jobQueue,
        startTask: deps.startTask,
        ...(advisoryBus ? { advisoryBus } : {}),
        enableDnsRebindingProtection: config.transports.http.enableDnsRebindingProtection,
        allowedHosts: config.transports.http.allowedHosts,
        allowedOrigins: config.transports.http.allowedOrigins,
        trustedProxies: config.transports.http.trustedProxies,
        forwardedHeader: config.transports.http.forwardedHeader,
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
      ...(reapOauthDb ? { reapOauthDb } : {}),
      close: async () => {
        if (httpHandle) await httpHandle.close();
        if (metricsHandle) await metricsHandle.close();
        oauthDb?.close();
        opened?.close();
      },
    };
  } catch (e) {
    oauthDb?.close();
    opened?.close();
    throw e;
  }
}
