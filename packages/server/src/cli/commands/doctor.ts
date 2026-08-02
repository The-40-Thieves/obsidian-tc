import { join } from "node:path";
import {
  bridgeState,
  buildVaultCapabilities,
  createBridgeClient,
  type RestApiOnDisk,
} from "../../bridge";
import { resolveCapabilityProfile } from "../../capability";
import { openDatabase } from "../../db/open";
import { assembleDoctorReport, type DenseProbeResult, renderText } from "../../doctor";
import { createEmbeddingProvider } from "../../embeddings";
import { ensureNotesFts, type NotesFtsIntegrity, verifyNotesFtsIntegrity } from "../../search/fts";
import { createQueryEncoder } from "../../search/query-encoder";
import { type Cmd, resolveOrUsageExit } from "../shared";

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
 * THE-688 fix 2 — the opt-in dense liveness probe behind `doctor --probe`.
 *
 * Encodes one short fixed string. That is the smallest call that exercises the whole path an
 * operator cares about: config resolution, credential lookup, network reach, and a response the
 * adapter can parse. A cheaper check (a TCP connect, a HEAD on the base URL) would have passed for
 * the failure this closes — Ollama's container was simply gone, but a wrong model name or a missing
 * API key look identical to a reachability test and are just as fatal.
 *
 * Goes through the SHARED `createQueryEncoder` rather than calling `provider.embed([...])` here.
 * Two reasons, and the architectural gate in query-encoder.test.ts enforces the first: a second
 * single-query encode in the tree is exactly what THE-622 consolidated away. The second is that it
 * makes this a better probe — it exercises the same path retrieval actually takes, including the
 * `input: "query"` asymmetric-prefix handling, so a provider that answers batches but breaks on
 * query-shaped input is caught rather than missed.
 *
 * Deliberately uses the SYNC `createEmbeddingProvider`, not the async one: the sync factory refuses
 * `provider: "module"` with an actionable error, so doctor's "never execute operator-supplied code"
 * rule holds BY CONSTRUCTION rather than through a special case here that could drift away from it.
 *
 * Never throws — every failure becomes a reason string. A diagnostic that dies while diagnosing is
 * useless exactly when it is needed.
 */
async function probeDenseProvider(
  embeddings: Parameters<typeof createEmbeddingProvider>[0],
): Promise<DenseProbeResult> {
  const started = Date.now();
  try {
    const encoder = createQueryEncoder(createEmbeddingProvider(embeddings));
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
 * THE-696 — the opt-in notes_fts integrity probe behind `doctor --probe`.
 *
 * Opens cache.db READ-WRITE, which is required: FTS5 exposes integrity-check as an INSERT into the
 * virtual table, so a read-only handle cannot run it. It writes nothing — the command only reads
 * the inverted index and reports — and WAL mode means this is safe alongside a running server.
 *
 * `ensureNotesFts` is called first because availability and soundness are different questions and
 * conflating them is the whole ticket: an adapter without FTS5 must report "off", not "malformed".
 *
 * Returns the availability flag alongside the verdict so the check can tell those two cases apart.
 * Never throws — a missing or unopenable cache.db degrades to "not verified" rather than killing a
 * diagnostic run, and a doctor that dies while diagnosing is useless exactly when it is needed.
 */
async function probeNotesFts(
  cacheDir: string,
): Promise<{ ftsEnabled: boolean; integrity?: NotesFtsIntegrity }> {
  let db: Awaited<ReturnType<typeof openDatabase>> | undefined;
  try {
    db = await openDatabase(join(cacheDir, "cache.db"));
    const ftsEnabled = ensureNotesFts(db);
    if (!ftsEnabled) return { ftsEnabled: false };
    return { ftsEnabled: true, integrity: verifyNotesFtsIntegrity(db) };
  } catch {
    // No cache.db yet (fresh install), or it cannot be opened. Either way there is no index to
    // pronounce on — fall back to the unprobed wording rather than inventing a verdict.
    return { ftsEnabled: process.env.OBSIDIAN_TC_DISABLE_FTS !== "1" };
  } finally {
    try {
      // `close` is OPTIONAL on the Database interface — the node:sqlite adapter used in tests and
      // in the .mcpb bundle does not expose it. Optional-call, not a bare `db?.close()`.
      db?.close?.();
    } catch {
      /* closing a handle we may never have opened must not fail the run */
    }
  }
}

// THE-521 — runtime health probe. Loads config, detects the environment (THE-522), runs the default
// check set, and emits either the versioned JSON envelope or human text rendered from it. Exits
// non-zero when any check fails, so scripts and CI can gate on health — a warning does not fail.
export async function run_doctor(cmd: Cmd<"doctor">): Promise<void> {
  const config = resolveOrUsageExit(cmd.configPath);
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
    ? await probeNotesFts(config.cacheDir)
    : { ftsEnabled: process.env.OBSIDIAN_TC_DISABLE_FTS !== "1" };

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
        sparseEnabled: config.retrieval.sparse,
        colbertEnabled: config.retrieval.colbert,
        // THE-688 fix 2: attached ONLY under --probe, so the default run stays offline.
        ...(cmd.probe ? { probe: () => probeDenseProvider(config.embeddings) } : {}),
      },
      // THE-648: snapshots default to enabled; surface the effective posture either way.
      snapshots: { enabled: config.snapshots.enabled, retention: config.snapshots.retention },
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
      // which hard-fails boot while doctor reported ok. Offline: reads config + env only.
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
