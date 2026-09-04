import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  bridgeState,
  buildVaultCapabilities,
  createBridgeClient,
  type RestApiOnDisk,
} from "../../bridge";
import { resolveCapabilityProfile } from "../../capability";
import { openDatabase } from "../../db/open";
import {
  assembleDoctorReport,
  type DenseProbeResult,
  renderText,
  resolveInstallRoot,
} from "../../doctor";
import { probeNoteSummariesScale } from "../../doctor/note-summary-scale";
import { createEmbeddingProvider } from "../../embeddings";
import { type EpisodeBacklog, readEpisodeBacklog } from "../../experiential/reflect";
import { compileEgressFilter, type EgressFilter } from "../../plane/egress-filter";
import { buildRerankerDoctorProbes, embeddingsDeprecation } from "../../providers/registry";
import type { ProviderDescriptor } from "../../providers/types";
import type { NotesFtsIntegrity } from "../../search/fts";
import { createQueryEncoder } from "../../search/query-encoder";
import { type Cmd, resolveOrUsageExit } from "../shared";
import {
  probeDerivedColumns,
  probeDerivedTables,
  probeEntryPoints,
  probeKbHealth,
  probeNotesFts,
} from "./doctor-probes";

// THE-523: derive the Local REST API plugin's on-disk state for a vault from the THE-522 capability
// profile — absent / disabled / enabled — so bridgeState can distinguish "cannot" from "will not".
// Returns undefined when the vault was not detected on disk (nothing to say).
function restApiOnDisk(
  profile: Awaited<ReturnType<typeof resolveCapabilityProfile>>,
  vaultPath: string,
): RestApiOnDisk | undefined {
  const vault = profile.obsidian.vaults.find((v) => v.path === vaultPath);
  if (!vault) return undefined;
  const plugin = vault.plugins.installed.find((p) => p.id === "obsidian-local-rest-api");
  if (!plugin) return "absent";
  return plugin.enabled ? "enabled" : "disabled";
}

/**
 * THE-688 fix 2 — the opt-in dense liveness probe behind `doctor --probe`. Goes through the
 * SHARED `createQueryEncoder` (not `provider.embed` directly — THE-622) and the SYNC
 * `createEmbeddingProvider` (refuses `provider: "module"` by construction). Never throws — every
 * failure becomes a reason string. See docs/design/cli-doctor.md.
 */
async function probeDenseProvider(
  embeddings: Parameters<typeof createEmbeddingProvider>[0],
  /** THE-934 fix round 2 (N2): threaded for consistency — createQueryEncoder's dense() call is
   *  query-role only (a literal probe string, never vault text), which the port guard exempts
   *  unconditionally, but this keeps "every createEmbeddingProvider call site threads
   *  excludeFilter" true by construction rather than a documented exception. */
  excludeFilter?: EgressFilter,
): Promise<DenseProbeResult> {
  const started = Date.now();
  try {
    const encoder = createQueryEncoder(createEmbeddingProvider(embeddings, { excludeFilter }));
    const vector = await encoder.dense("obsidian-tc doctor probe");
    const ms = Date.now() - started;
    // `dense()` DEGRADES an absent vector to [] rather than throwing (deliberate, so a retrieval
    // path stays alive). For a liveness probe that degradation is the failure being looked for, so
    // length 0 must be read as "no answer" and never as a successful probe of a 0-dim model.
    const dim = vector.length;
    if (dim === 0) return { ok: false, reason: "provider returned no vector" };
    // A dimension mismatch is a silent corruption, not a nicety: the vec index is built at the
    // configured width, so a provider answering at a different one indexes garbage while every
    // reachability signal stays green.
    if (dim !== embeddings.dimensions)
      return {
        ok: false,
        reason: `provider answered with dim ${dim}, but embeddings.dimensions is ${embeddings.dimensions}`,
      };
    return { ok: true, ms };
  } catch (e) {
    return { ok: false, reason: (e as Error)?.message ?? String(e) };
  }
}

/**
 * THE-698 — the opt-in pending-episode backlog count behind `doctor --probe`. Counts rather than
 * evaluates (diagnosing must never promote a row) and reports the oldest pending episode's AGE
 * alongside the count — the count alone can't discriminate a healthy backlog from a stalled
 * evaluator. Path is passed PLAIN, never as `file:...?mode=ro` — `openDatabase` treats a URI as a
 * literal filename, not a read-only flag. Never throws. See docs/design/cli-doctor.md.
 */
async function probeEpisodeBacklog(
  cacheDir: string,
  nowMs: number,
  // THE-726 review round 1: `experiential.derivedVerdictHold`, forwarded to readEpisodeBacklog so
  // this diagnostic agrees with what the evaluator would actually promote — previously omitted,
  // which silently defaulted to the flag's own default (false) even on a deployment running with
  // it on, disagreeing with the real evaluator on exactly the rows the flag changes.
  derivedVerdictHold: boolean,
  busyTimeoutMs: number,
): Promise<EpisodeBacklog | undefined> {
  const path = join(cacheDir, "experiential.db");
  if (!existsSync(path)) return undefined;
  let edb: Awaited<ReturnType<typeof openDatabase>> | undefined;
  try {
    edb = await openDatabase(path, busyTimeoutMs);
    // Delegates to reflect.ts rather than counting here: `promotable` must be computed by the SAME
    // predicates the evaluator promotes by, or the checker and the evaluator disagree about what
    // is healthy. A hand-rolled GROUP BY here counted `pending` and warned on a store that had
    // just been promoted successfully.
    return readEpisodeBacklog(edb, nowMs, derivedVerdictHold);
  } catch {
    return undefined;
  } finally {
    try {
      edb?.close?.();
    } catch {
      /* see probeNotesFts */
    }
  }
}

/**
 * Does this ACL block actually restrict anything?
 *
 * `acl` is present on every resolved config — `rules` and `defaultScopes` both default to `[]` —
 * so testing for the OBJECT reports every deployment as ACL-configured, and the path-set cache
 * then looks "configured but empty" on installs that correctly never build one. Content is the
 * only honest signal.
 */
function hasAclRules(acl: { rules?: unknown[]; readPaths?: unknown[] } | undefined): boolean {
  if (!acl) return false;
  return (acl.rules?.length ?? 0) > 0 || (acl.readPaths?.length ?? 0) > 0;
}

// THE-521 — runtime health probe. Loads config, detects the environment (THE-522), runs the default
// check set, and emits either the versioned JSON envelope or human text rendered from it. Exits
// non-zero when any check fails, so scripts and CI can gate on health — a warning does not fail.
export async function run_doctor(cmd: Cmd<"doctor">): Promise<void> {
  const config = resolveOrUsageExit(cmd.configPath);
  const busyTimeoutMs = config.db.busyTimeoutMs; // THE-935: short alias for every probe call below
  // THE-705 round 2: the same configDir convention server-runtime.ts uses for wireGatewaySeams —
  // the trust root for reranker.localModulePath when it's given relative. Needed here so doctor's
  // "local" probe resolves a relative override exactly the way boot would.
  const configDir = cmd.configPath !== undefined ? dirname(cmd.configPath) : undefined;
  // Include the configured vault paths so they appear even when the desktop registry is absent
  // (headless/server boxes), which is exactly where doctor is most useful.
  const profile = await resolveCapabilityProfile({
    extraVaultPaths: config.vaults.map((v) => v.path),
  });

  // THE-523 bridge.state: probe each vault's companion live, then resolve state using the THE-522
  // on-disk detection so "cannot vs will not" is distinguished (absent / disabled / enabled-but-
  // unreachable). Probing never throws — a vault with no endpoint resolves to headless.
  const bridgeReports = await Promise.all(
    config.vaults.map(async (v) => {
      const client = v.restApiUrl
        ? createBridgeClient({
            baseUrl: v.restApiUrl,
            apiKey: v.restApiKey,
            timeoutMs: v.bridges?.timeoutMs,
          })
        : undefined;
      const snap = await buildVaultCapabilities(client, {
        probeSkip: v.plugins?.probeSkip,
        forceEnabled: v.plugins?.forceEnabled,
        forceDisabled: v.plugins?.forceDisabled,
        timeoutMs: v.bridges?.probeTimeoutMs,
      });
      return {
        vaultId: v.id,
        report: bridgeState(snap, { restApiOnDisk: restApiOnDisk(profile, v.path) }),
      };
    }),
  );

  // THE-696: only under --probe does this open cache.db at all, so the default run stays offline
  // and side-effect-free by construction, exactly like the dense probe above.
  const notesFts = cmd.probe
    ? await probeNotesFts(config.cacheDir, busyTimeoutMs)
    : { ftsEnabled: process.env.OBSIDIAN_TC_DISABLE_FTS !== "1" };

  // THE-698: episode capture is on when any of the three experiential gates is set — the same
  // three that decide `experientialOpen` in runtime/stores.ts. Derived from config here rather
  // than re-asked, so doctor cannot disagree with the server about whether the tier is live.
  const experientialEnabled =
    config.experiential.logRetrievals ||
    config.experiential.captureEpisodes ||
    config.experiential.activationRerank;
  const backlog =
    cmd.probe && experientialEnabled
      ? await probeEpisodeBacklog(
          config.cacheDir,
          Date.now(),
          config.experiential.derivedVerdictHold,
          busyTimeoutMs,
        )
      : undefined;
  // The multi-vector gate is ONE decision that darkens two tables: chunk_sparse and chunk_colbert
  // are both written from embedFull, which only some providers emit. Mirrors the same expression
  // retrievalHeads uses below so doctor cannot disagree with itself about provider capability.
  const entryPoints = cmd.probe
    ? await probeEntryPoints(config.cacheDir, busyTimeoutMs)
    : undefined;
  const derivedTables = cmd.probe
    ? await probeDerivedTables(config.cacheDir, busyTimeoutMs, {
        multiVector:
          config.embeddings.provider === "bge-m3" ||
          (config.embeddings.provider === "model-tier" &&
            config.embeddings.modelTier?.full !== undefined),
        experiential: experientialEnabled,
        // ACL-configured only when a rule/defaultScope actually exists, not merely declared — see
        // hasAclRules above.
        aclConfigured: hasAclRules(config.acl) || config.vaults.some((v) => hasAclRules(v.acl)),
        snapshots: config.snapshots.enabled,
        // The SCHEDULER's own predicate, mirrored. scheduler-wiring registers the sweep on exactly
        // this; reading `experiential` here instead is what produced the wrong classification.
        gapSweepScheduled: experientialEnabled && config.experiential.gapSweep.enabled,
      })
    : undefined;
  // THE-720: the column-level companion. Same probe gate and the same experiential predicate the
  // table probe uses, so the two cannot disagree about whether the store is on.
  const derivedColumns = cmd.probe
    ? await probeDerivedColumns(config.cacheDir, busyTimeoutMs, {
        experiential: experientialEnabled,
      })
    : undefined;
  // THE-722: the reader audit_reports never had.
  const kbHealth = cmd.probe ? await probeKbHealth(config.cacheDir, busyTimeoutMs) : undefined;
  // THE-891 item 5: per-vault note-summary scan size, only under --probe (same contract as every
  // other store-touching probe above).
  const noteSummariesScale = cmd.probe
    ? await probeNoteSummariesScale(
        config.cacheDir,
        config.vaults.map((v) => v.id),
        busyTimeoutMs,
      )
    : undefined;

  const report = await assembleDoctorReport({
    config: {
      auth: {
        mode: config.auth.mode,
        tokenTtlSeconds: config.auth.tokenTtlSeconds,
        readOnly: config.acl.readOnly,
      },
      // #16: retrieval-head readiness. The sparse/ColBERT streams only emit when the provider
      // produces the multi-vector heads (bge-m3, or model-tier with modelTier.full configured).
      retrieval: {
        denseProvider: config.embeddings.provider,
        denseModel: config.embeddings.model,
        denseDimensions: config.embeddings.dimensions,
        multiVector:
          config.embeddings.provider === "bge-m3" ||
          (config.embeddings.provider === "model-tier" &&
            config.embeddings.modelTier?.full !== undefined),
        // A provider name no longer implies a capability set: a generic provider may well point at
        // a bge-m3 endpoint. Report what is CONFIGURED rather than inferring from the name.
        rerankerConfigured: config.reranker?.provider,
        // THE-837: read straight off the registry entry rather than restated here, so the notice
        // cannot drift from the entry that owns it. Assigned unconditionally (undefined when the
        // provider carries no notice) rather than conditionally spread — THE-732: TypeScript
        // exempts spreads from excess-property checking, so a misspelled key in a spread is
        // silently dropped and the field just never arrives.
        denseDeprecated: embeddingsDeprecation(config.embeddings.provider),
        sparseEnabled: config.retrieval.sparse,
        colbertEnabled: config.retrieval.colbert,
        // THE-688 fix 2: attached ONLY under --probe, so the default run stays offline.
        ...(cmd.probe
          ? {
              probe: () =>
                probeDenseProvider(
                  config.embeddings,
                  compileEgressFilter(config.egress.excludePaths),
                ),
            }
          : {}),
      },
      // THE-648: snapshots default to enabled; surface the effective posture either way.
      snapshots: { enabled: config.snapshots.enabled, retention: config.snapshots.retention },
      // THE-698: capture state always; the backlog count only when --probe looked.
      experientialEvaluator: {
        enabled: experientialEnabled,
        ...(backlog !== undefined ? { probe: () => backlog } : {}),
      },
      // Derived-table liveness. Probe-only for the same reason as every other store-touching check:
      // a default run must not open either database.
      entryPoints: {
        ...(entryPoints !== undefined ? { probe: () => entryPoints } : {}),
      },
      derivedTables: {
        ...(derivedTables !== undefined ? { probe: () => derivedTables } : {}),
      },
      derivedColumns: {
        ...(derivedColumns !== undefined ? { probe: () => derivedColumns } : {}),
      },
      kbHealth: {
        ...(kbHealth !== undefined ? { probe: () => kbHealth } : {}),
      },
      // THE-891 item 5: `enabled` reflects whether the summary candidate stream can even run; the
      // per-vault counts only when --probe looked, same reasoning as notesFts above.
      noteSummariesScale: {
        enabled: config.retrieval.summaries?.enabled ?? false,
        ...(noteSummariesScale !== undefined ? { probe: () => noteSummariesScale } : {}),
      },
      // THE-891 item 3: cacheDir-vs-vault-root check. Always present, no --probe gate — this is
      // a pure path comparison over already-resolved config, not a store touch.
      captureLocation: {
        cacheDir: config.cacheDir,
        vaults: config.vaults.map((v) => ({ id: v.id, path: v.path })),
      },
      // THE-939: the install directory to walk for sync-service conflict copies. Resolved once per
      // run — undefined on a compiled binary with no source tree on this machine, in which case
      // the check reports not-applicable rather than a false "no conflict copies found".
      conflictCopies: { installRoot: resolveInstallRoot() },
      // THE-696: notes_fts availability always; the integrity verdict only when --probe looked.
      notesFts: {
        ftsEnabled: notesFts.ftsEnabled,
        ...(notesFts.integrity !== undefined
          ? { probe: () => notesFts.integrity as NotesFtsIntegrity }
          : {}),
      },
      // Final-review blocker 2: validate the configured provider names against the registry —
      // an unregistered name parses cleanly now (embeddings.provider/reranker.provider are open
      // strings) and was previously invisible to doctor.
      providers: {
        embeddingsProvider: config.embeddings.provider,
        ...(config.reranker?.provider !== undefined
          ? { rerankerProvider: config.reranker.provider }
          : {}),
      },
      // THE-679: names alone are not enough. A declared block naming a registered provider can
      // still be unbuildable (model-tier without embeddings.modelTier.full; gateway with no URL),
      // which hard-fails boot while doctor reported ok. Offline: reads config + env only — except
      // "local" (THE-705 round 2) and THE-944's auto-select case, both of which get a real
      // resolution probe via the shared `probeLocalRerankerResolution` — see
      // RerankerBuildableView.probeLocalReranker's comment for why that's not a "no filesystem,
      // no dynamic import" violation of this check's usual posture. The probe fields themselves are
      // built by `buildRerankerDoctorProbes` (providers/registry.ts) — extracted from here in
      // review round 2 once G3's `autoSelectBlockedByPlatform` distinction pushed this file over
      // biome's line cap; that function's own doc comment covers the auto-select/platform logic.
      rerankerBuildable: {
        ...(config.reranker?.provider !== undefined
          ? { rerankerProvider: config.reranker.provider }
          : {}),
        ...(config.reranker?.baseUrl !== undefined
          ? { rerankerBaseUrl: config.reranker.baseUrl }
          : {}),
        embeddings: config.embeddings,
        ...(process.env.OBSIDIAN_TC_GATEWAY_URL !== undefined
          ? { gatewayUrlEnv: process.env.OBSIDIAN_TC_GATEWAY_URL }
          : {}),
        ...buildRerankerDoctorProbes({
          rerankerCfg: config.reranker as ProviderDescriptor | undefined,
          embeddings: config.embeddings,
          gatewayBaseUrl: config.gateway?.baseUrl,
          gatewayUrlEnv: process.env.OBSIDIAN_TC_GATEWAY_URL,
          configDir,
          securityProfile: config.securityProfile,
        }),
      },
    },
    profile,
    bridgeReports,
    ...(cmd.token !== undefined ? { token: cmd.token } : {}),
  });

  process.stdout.write(
    cmd.json ? `${JSON.stringify(report, null, 2)}\n` : `${renderText(report)}\n`,
  );
  if (report.overallStatus === "fail") process.exit(1);
}
