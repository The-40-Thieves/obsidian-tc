// server-runtime.ts's `start()` was pushed over biome's 700-line ceiling by THE-891 item 2's new
// capture notice — the three stderr-only, side-effect-free boot notices (security posture
// summary, THE-825 plane opt-in, THE-891 capture first-run) are pulled into this one call so the
// composition root stays under it. Same "extracted for the line budget, behavior unchanged"
// reasoning maintenance-wiring.ts's own header documents for THE-466 slice 3: nothing about WHEN
// or WHAT these print changes, only where the code that decides it lives. All three were already
// independent blocks with no shared state beyond `config`, so folding them into one function is a
// pure move, not a refactor of behavior.
import {
  isFeedbackExemptFromReadOnly,
  type ServerConfig,
} from "@the-40-thieves/obsidian-tc-shared";
import type { Database } from "../db/types";
import { hiddenNamesInAllowlist } from "../doctor/tool-facade";
import { redactEndpoint } from "../telemetry/redact-endpoint";
import {
  type StaleExplicitSessionSummary,
  staleExplicitSessionSummary,
} from "../workspace/sessions";
import { emitCaptureFirstRunNotice } from "./capture-first-run-notice";
import { formatPlaneOptInNotice } from "./plane-opt-in-notice";

/** THE-1099 (GH #964 part 2): whether `record_retrieval_feedback` actually bypasses the
 *  `acl.readOnly` kill switch right now. Delegates to the shared `isFeedbackExemptFromReadOnly` —
 *  the same predicate server-runtime.ts's wiring calls to build the registry's
 *  `toolVisibility.allowReadOnlyDerivedTelemetry` — so the boot line and dispatch enforcement can
 *  never disagree about whether the exemption is live. Exported so the boot-line format is
 *  testable without booting a real runtime. */
export function readOnlyFeedbackExemptionActive(
  config: Pick<ServerConfig, "experiential">,
): boolean {
  return isFeedbackExemptFromReadOnly(config.experiential);
}

/** THE-1108 fix (Codex P2): pure formatter for the stale-explicit-session boot notice, split out
 *  the same way `readOnlyFeedbackExemptionActive` above is — testable without a real db or a full
 *  config. `maintenanceEnabled` decides the CLOSING sentence: with `maintenance.enabled: false`,
 *  `configureMaintenance` (maintenance-wiring.ts) registers no sweep at all, so the original
 *  unconditional "the maintenance sweep will close them" would be a promise nothing keeps.
 *  Returns `undefined` when there is nothing stale to report. */
export function formatStaleExplicitSessionNotice(
  stale: StaleExplicitSessionSummary,
  opts: { maxExplicitLifetimeSeconds: number; maintenanceEnabled: boolean },
): string | undefined {
  if (stale.count === 0) return undefined;
  const oldestDays = ((stale.oldestAgeMs ?? 0) / 86_400_000).toFixed(1);
  const closing = opts.maintenanceEnabled
    ? "The maintenance sweep will close them on its own schedule (maintenance.intervalMinutes); " +
      "call end_session yourself if you want it sooner.\n"
    : "maintenance.enabled is false, so nothing will close them automatically — call end_session " +
      "yourself, or turn maintenance on.\n";
  return (
    `sessions: ${stale.count} open explicit session(s) already past sessions.maxExplicitLifetimeSeconds ` +
    `(${opts.maxExplicitLifetimeSeconds}s) at boot — oldest is ${oldestDays}d old` +
    (stale.oldestPrincipal !== null ? ` (principal: ${stale.oldestPrincipal})` : "") +
    ". " +
    closing
  );
}

export function emitBootNotices(deps: {
  config: ServerConfig;
  /** `roles !== null` at the buildServerRuntime call site — see plane-opt-in-notice.ts. */
  gatewayConfigured: boolean;
  /** Whether the raw (pre-default) config explicitly set `plane.enabled` — see
   *  config/load.ts's `isPlaneEnabledExplicit`. */
  planeEnabledExplicit: boolean;
  /** THE-1108: cache.db handle, so the stale-explicit-session notice below can read
   *  workspace_sessions. */
  db: Database;
}): void {
  const { config } = deps;

  // Security posture summary (audit #268 P1): make the active profile obvious at startup, and
  // warn when the permissive trusted-local defaults are active — governed by default is not
  // least-privilege by default. stderr only (the stdio MCP protocol owns stdout).
  const rootAcl = config.acl;
  // THE-526: name the active profile so it is a stated fact, not something inferred from six
  // fields.
  const profile = config.securityProfile ?? "trusted-local";
  // THE-1099 (GH #964 part 2): the one read-only exemption that exists today — printed
  // unconditionally, not only when readOnly is true, so an operator reading the boot log never
  // has to reconstruct the AND (allowFeedbackInReadOnly && logRetrievals) from two separate config
  // reads to know whether it is live.
  process.stderr.write(
    `security: profile=${profile} auth=${config.auth.mode} readOnly=${rootAcl.readOnly} strictRead=${rootAcl.strictReadDefault} requireCas=${config.writes.requireCas} http=${config.transports.http.enabled ? "on" : "off"} readOnlyFeedbackExempt=${readOnlyFeedbackExemptionActive(config)}\n`,
  );
  if (
    config.auth.mode === "none" &&
    !rootAcl.readOnly &&
    !rootAcl.strictReadDefault &&
    !config.writes.requireCas
  ) {
    process.stderr.write(
      "security: running with trusted-local defaults (auth=none, no strict-read, no CAS). For a " +
        'shared or multi-caller deployment set securityProfile: "hardened" (strictReadDefault, ' +
        "requireCas, snapshots, HTTP off) plus your read/write paths, or copy " +
        "examples/config.hardened.json.\n",
    );
  }

  // THE-825: plane opt-in boot notice — silent by default is the failure mode this closes. See
  // plane-opt-in-notice.ts.
  const planeNotice = formatPlaneOptInNotice({
    gatewayConfigured: deps.gatewayConfigured,
    planeEnabledExplicit: deps.planeEnabledExplicit,
  });
  if (planeNotice) process.stderr.write(planeNotice);

  // THE-891 item 2: one-time (per-install) capture notice — see capture-first-run-notice.ts.
  emitCaptureFirstRunNotice({
    captureContent: config.experiential.captureContent,
    cacheDir: config.cacheDir,
    retentionDays: config.experiential.captureRetentionDays,
  });

  // THE-1125: opt-in telemetry boot notice — one line naming the endpoint and the docs page,
  // printed EVERY boot (not one-time like the capture notice above), for the same reason the
  // security posture line above is unconditional: an operator reading the boot log must not have
  // to go find the config file to learn this server phones home. stderr only, and only when
  // enabled — a disabled/default config prints nothing (config validation already refuses
  // `enabled: true` with no `endpoint`, so this can only ever name a real host).
  if (config.telemetry.enabled && config.telemetry.endpoint !== undefined) {
    // redactEndpoint (never the raw URL — userinfo/query/path could carry a collector key):
    // scheme + host only.
    const endpointRedacted = redactEndpoint(config.telemetry.endpoint);
    process.stderr.write(
      `telemetry: opt-in usage telemetry is ENABLED, sending to ${endpointRedacted} every ` +
        `${config.telemetry.intervalMinutes}m. Aggregate counts only (no paths, note content, ` +
        "queries, vault ids, principals, tokens, hostnames or env) — see " +
        "docs/configuration/telemetry.md, `obsidian-tc telemetry preview`, or SECURITY.md. " +
        "Disable with telemetry.enabled: false.\n",
    );
  }

  // THE-1131 review round 2: an allowlist naming a tool `toolFacade.profile` hides is dead
  // config — profile wins the precedence race, so the allowlist entry can never restore it. Same
  // `hiddenNamesInAllowlist` predicate `doctor` uses, so the boot line and the offline check can
  // never disagree.
  const staticHidden = hiddenNamesInAllowlist(
    config.toolVisibility?.allowed,
    config.toolFacade.profile,
  );
  if (staticHidden.length > 0) {
    process.stderr.write(
      `toolFacade: toolVisibility.allowed names ${staticHidden.length} tool(s) hidden by toolFacade.profile: ${staticHidden.join(", ")}\n`,
    );
  }
  for (const [personaName, persona] of Object.entries(config.personas ?? {})) {
    const personaHidden = hiddenNamesInAllowlist(
      persona.toolVisibility?.allowed,
      config.toolFacade.profile,
    );
    if (personaHidden.length > 0) {
      process.stderr.write(
        `toolFacade: personas.${personaName}.toolVisibility.allowed names ${personaHidden.length} tool(s) hidden by toolFacade.profile: ${personaHidden.join(", ")}\n`,
      );
    }
  }

  // THE-1108: a session this old already predates the absolute-lifetime bound the maintenance
  // sweep enforces. One line at boot so an operator reading the log sees it immediately rather
  // than only after the first sweep runs — see formatStaleExplicitSessionNotice for why the
  // closing sentence depends on whether a sweep will actually run at all (fix round, Codex P2).
  const staleAtBoot = staleExplicitSessionSummary(deps.db, {
    now: Date.now(),
    thresholdSeconds: config.sessions.maxExplicitLifetimeSeconds,
  });
  const staleNotice = formatStaleExplicitSessionNotice(staleAtBoot, {
    maxExplicitLifetimeSeconds: config.sessions.maxExplicitLifetimeSeconds,
    maintenanceEnabled: config.maintenance.enabled,
  });
  if (staleNotice !== undefined) process.stderr.write(staleNotice);
}
