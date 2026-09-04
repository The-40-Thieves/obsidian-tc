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
  type DerivedColumnState,
  type DerivedTableState,
  type EntryPointsProbe,
  type KbHealthProbe,
  renderText,
  resolveInstallRoot,
} from "../../doctor";
import { experientialColumnSpec } from "../../doctor/column-spec";
import { probeNoteSummariesScale } from "../../doctor/note-summary-scale";
import { experientialTableSpec } from "../../doctor/table-spec";
import { createEmbeddingProvider } from "../../embeddings";
import { type EpisodeBacklog, readEpisodeBacklog } from "../../experiential/reflect";
import { compileEgressFilter, type EgressFilter } from "../../plane/egress-filter";
import { buildRerankerDoctorProbes, embeddingsDeprecation } from "../../providers/registry";
import type { ProviderDescriptor } from "../../providers/types";
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
 * THE-696 — the opt-in notes_fts integrity probe behind `doctor --probe`. Opens cache.db
 * READ-WRITE — FTS5 exposes integrity-check as an INSERT into the virtual table, so a read-only
 * handle cannot run it; WAL mode keeps this safe alongside a running server. Checks
 * `ensureNotesFts` first: availability ("off") and soundness ("malformed") are different
 * questions. Never throws. See docs/design/cli-doctor.md.
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
): Promise<EpisodeBacklog | undefined> {
  const path = join(cacheDir, "experiential.db");
  if (!existsSync(path)) return undefined;
  let edb: Awaited<ReturnType<typeof openDatabase>> | undefined;
  try {
    edb = await openDatabase(path);
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

/**
 * Count rows in the derived tables and classify each one's writer, for `derived.liveness`. The
 * classification is load-bearing: a row count alone can't distinguish "switched off" from "on and
 * never worked" — only the second is a finding. `writer: "none"` means no code path writes the
 * table at all, distinct from "disabled". See `table-spec.ts` for the current classification per
 * table (THE-629 corrected an earlier misclassification here — docs/design/cli-doctor.md). Never
 * throws: a missing store degrades to an empty list, not a wall of false warnings.
 */
/**
 * Sample the signal-bearing columns for `derived.column-liveness` (THE-720): total rows, non-NULL
 * rows, distinct non-NULL values, one aggregate per column. Re-read per column rather than cached
 * per table — a missing column must degrade to "skip this entry", not "table has no rows" (which
 * would mark every OTHER column on that table inconclusive too). Never throws, same contract as
 * probeDerivedTables. See docs/design/cli-doctor.md.
 */
/**
 * Read the newest kb_health report for `audit.kbHealth` (THE-722) — the reader `audit_reports`
 * never had; see docs/design/cli-doctor.md. Reads only, and never throws: a missing table (a store
 * predating the plane migration) degrades to `undefined`, rendered as "never run".
 */
async function probeKbHealth(cacheDir: string): Promise<KbHealthProbe | undefined> {
  const path = join(cacheDir, "cache.db");
  if (!existsSync(path)) return undefined;
  let db: Awaited<ReturnType<typeof openDatabase>> | undefined;
  try {
    db = await openDatabase(path);
    const agg = db
      .prepare("SELECT COUNT(*) AS n, MAX(created_at) AS latest FROM audit_reports")
      .get() as { n: number; latest: number | null } | undefined;
    if (!agg || agg.n === 0) {
      return {
        totalReports: 0,
        now: Date.now(),
        hasIssues: false,
        summary: "",
        nullEmbeddings: 0,
        duplicateChunkPositions: 0,
        perVault: [],
      };
    }
    const row = db
      .prepare(
        "SELECT created_at, has_issues, summary, report FROM audit_reports ORDER BY created_at DESC LIMIT 1",
      )
      .get() as { created_at: number; has_issues: number; summary: string; report: string };
    // The JSON column is the job's own AuditReport. Parsed defensively: a malformed row must not
    // take doctor down, and the counts degrade to 0 rather than to a false alarm.
    let parsed: {
      vault_null_embeddings?: number;
      duplicate_chunk_positions?: number;
      per_vault?: unknown;
    } = {};
    try {
      parsed = JSON.parse(row.report ?? "{}");
    } catch {
      /* keep the empty shape */
    }
    return {
      totalReports: agg.n,
      latestAt: row.created_at,
      now: Date.now(),
      hasIssues: row.has_issues === 1,
      summary: row.summary ?? "",
      nullEmbeddings: Number(parsed.vault_null_embeddings ?? 0),
      duplicateChunkPositions: Number(parsed.duplicate_chunk_positions ?? 0),
      perVault: Array.isArray(parsed.per_vault)
        ? (parsed.per_vault as KbHealthProbe["perVault"])
        : [],
    };
  } catch {
    return undefined;
  } finally {
    try {
      db?.close?.();
    } catch {
      /* see probeNotesFts */
    }
  }
}

async function probeDerivedColumns(
  cacheDir: string,
  cfg: { experiential: boolean },
): Promise<DerivedColumnState[]> {
  const out: DerivedColumnState[] = [];
  const expPath = join(cacheDir, "experiential.db");
  if (!existsSync(expPath)) return out;
  let edb: Awaited<ReturnType<typeof openDatabase>> | undefined;
  try {
    edb = await openDatabase(expPath);
    for (const s of experientialColumnSpec(cfg)) {
      try {
        const r = edb
          .prepare(
            `SELECT COUNT(*) AS rows, COUNT("${s.column}") AS nn,
                    COUNT(DISTINCT "${s.column}") AS d FROM "${s.table}"`,
          )
          .get() as { rows: number; nn: number; d: number };
        out.push({
          column: `experiential.${s.table}.${s.column}`,
          rows: r.rows,
          nonNull: r.nn,
          distinct: r.d,
          writer: s.writer,
          lever: s.lever,
        });
      } catch {
        // Table or column absent — a store predating the migration that added it. Dropping the
        // entry is right: reporting a column that does not exist as "never written" is a finding
        // about the schema, which the migration chain already owns.
      }
    }
  } catch {
    /* leave what we have */
  } finally {
    try {
      edb?.close?.();
    } catch {
      /* see probeNotesFts */
    }
  }
  return out;
}

async function probeDerivedTables(
  cacheDir: string,
  cfg: {
    /** True when the configured embeddings provider emits embedFull (the sparse/ColBERT heads). */
    multiVector: boolean;
    /** True when any experiential gate is on — the same three the server uses. */
    experiential: boolean;
    /** True when an ACL block is declared at the root or on any vault. The path-set cache is only
     *  ever built for a caller whose ACL actually filters something. */
    aclConfigured: boolean;
    /** True when destructive note writes capture an undo (config.snapshots.enabled). */
    snapshots: boolean;
    /** True when the coverage-gap sweep is SCHEDULED, not merely when the store is open. */
    gapSweepScheduled: boolean;
  },
): Promise<DerivedTableState[]> {
  const out: DerivedTableState[] = [];
  const count = (db: Awaited<ReturnType<typeof openDatabase>>, table: string): number | null => {
    try {
      const r = db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get() as { c: number };
      return r.c;
    } catch {
      return null; // table absent — runtime-provisioned and never created, same as zero rows
    }
  };

  const cachePath = join(cacheDir, "cache.db");
  if (existsSync(cachePath)) {
    let db: Awaited<ReturnType<typeof openDatabase>> | undefined;
    try {
      db = await openDatabase(cachePath);
      const multiVectorLever = "an embeddings provider emitting embedFull (bge-m3 / model-tier)";
      const spec: Array<[string, DerivedTableState["writer"], string]> = [
        // Both heads come from the SAME gate: embedFull exists only on providers that emit it, so
        // a dense-only provider darkens both at once. One config line, two dark tables.
        ["chunk_sparse", cfg.multiVector ? "enabled" : "disabled", multiVectorLever],
        ["chunk_colbert", cfg.multiVector ? "enabled" : "disabled", multiVectorLever],
        // memory_entities/memory_relations report `on-demand`, not `none` — a client calling
        // create_entity/link_entities is a valid, if rare, writer (THE-629). See
        // docs/design/cli-doctor.md.
        ["memory_entities", "on-demand", "a client calling create_entity (THE-629)"],
        ["memory_relations", "on-demand", "a client calling link_entities (THE-629)"],
        // Client- and user-driven surface: enabled means the verb is registered and reachable;
        // empty means it has never been exercised. THE-726: `sessions.autoOpen` also lets the
        // server open one itself on a principal's first dispatch — still on-demand, off by
        // default. See docs/design/cli-doctor.md.
        [
          "workspace_sessions",
          "on-demand",
          "a client calling start_session, or the server itself under sessions.autoOpen (THE-726)",
        ],
        ["capture_queue", "on-demand", "a client calling the capture verb"],
        [
          "note_snapshots",
          cfg.snapshots ? "on-demand" : "disabled",
          "a destructive note write while snapshots.enabled (restore_note has nothing to restore until then)",
        ],
        [
          "snapshot_blobs",
          cfg.snapshots ? "on-demand" : "disabled",
          "a destructive note write while snapshots.enabled",
        ],
        // Built per-caller only when an ACL actually filters something.
        [
          "acl_path_sets",
          cfg.aclConfigured ? "enabled" : "disabled",
          "an `acl` block at the root or on a vault",
        ],
        [
          "acl_path_members",
          cfg.aclConfigured ? "enabled" : "disabled",
          "an `acl` block at the root or on a vault",
        ],
        // plane.ts's recordRun writes this unconditionally when the table exists, and plane-wiring
        // imports wrapPlaneJob — so an empty table here is worth surfacing, not assuming.
        ["job_runs", "enabled", "plane jobs recording their runs via wrapPlaneJob"],
        // Derived planes that ARE writing today — included so `live` is non-empty and the check can
        // demonstrate it distinguishes success from silence, not just report problems.
        ["contradictions", "enabled", "the contradiction plane job"],
        ["syntheses", "enabled", "the weekly synthesis plane job"],
        ["vault_edges", "enabled", "the indexer deriving links from notes"],
      ];
      for (const [table, writer, lever] of spec) {
        const c = count(db, table);
        out.push({ table, rows: c ?? 0, writer, lever });
      }
    } catch {
      /* leave what we have */
    } finally {
      try {
        db?.close?.();
      } catch {
        /* see probeNotesFts */
      }
    }
  }

  const expPath = join(cacheDir, "experiential.db");
  if (existsSync(expPath)) {
    let edb: Awaited<ReturnType<typeof openDatabase>> | undefined;
    try {
      edb = await openDatabase(expPath);
      // The SET lives in doctor/table-spec.ts so it can be asserted independently of the probe
      // that consumes it — same separation, and same floor argument, as column-spec.ts.
      const spec = experientialTableSpec(cfg);
      for (const { table, writer, lever } of spec) {
        const c = count(edb, table);
        out.push({ table: `experiential.${table}`, rows: c ?? 0, writer, lever });
      }
    } catch {
      /* leave what we have */
    } finally {
      try {
        edb?.close?.();
      } catch {
        /* see probeNotesFts */
      }
    }
  }
  return out;
}

/**
 * Read the scheduler's own durable state and the tool-invocation census, for
 * `entrypoints.liveness` — both already written by the running server, so this reads truth rather
 * than deriving it. Filters `job_schedule` on `name IS NOT NULL`: SQLite does not enforce NOT NULL
 * on a TEXT PRIMARY KEY, so a null-named UPSERT inserts instead of updating (THE-715). The tool
 * census is a LOWER BOUND — `null` means NOT MEASURED, never coerced to 0. Never throws. See
 * docs/design/cli-doctor.md.
 */
async function probeEntryPoints(cacheDir: string): Promise<EntryPointsProbe> {
  const out: EntryPointsProbe = { passes: [], tools: null, orphanScheduleRows: 0 };

  const cachePath = join(cacheDir, "cache.db");
  if (existsSync(cachePath)) {
    let db: Awaited<ReturnType<typeof openDatabase>> | undefined;
    try {
      db = await openDatabase(cachePath);
      const rows = db
        .prepare(
          "SELECT name, last_run_at, last_success_at, consecutive_failures FROM job_schedule WHERE name IS NOT NULL ORDER BY name",
        )
        .all() as Array<{
        name: string;
        last_run_at: number | null;
        last_success_at: number | null;
        consecutive_failures: number;
      }>;
      out.passes = rows.map((r) => ({
        name: r.name,
        lastRunAt: r.last_run_at,
        lastSuccessAt: r.last_success_at,
        consecutiveFailures: r.consecutive_failures,
      }));
      const orphans = db
        .prepare("SELECT COUNT(*) AS c FROM job_schedule WHERE name IS NULL")
        .get() as { c: number };
      out.orphanScheduleRows = orphans.c;
      // THE-716: run HISTORY, in its own try so a store without job_runs still reports the
      // schedule state above. `runs` stays null when the table is absent — not measured and
      // measured-zero are different facts, and the check renders them differently.
      try {
        const agg = db
          .prepare(
            "SELECT COUNT(*) AS n, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed, " +
              "COUNT(DISTINCT job) AS jobs, MIN(started_at) AS oldest, MAX(started_at) AS newest FROM job_runs",
          )
          .get() as {
          n: number;
          failed: number | null;
          jobs: number;
          oldest: number | null;
          newest: number | null;
        };
        const names = db.prepare("SELECT DISTINCT job FROM job_runs ORDER BY job").all() as {
          job: string;
        }[];
        out.runs = {
          totalRuns: agg.n,
          failures: agg.failed ?? 0,
          jobs: names.map((r) => r.job),
          oldestAt: agg.oldest,
          newestAt: agg.newest,
        };
      } catch {
        /* no job_runs table — leave `runs` unset (not measured) */
      }
    } catch {
      /* table absent on a pre-scheduler db — leave the empty list */
    } finally {
      try {
        db?.close?.();
      } catch {
        /* see probeNotesFts */
      }
    }
  }

  const expPath = join(cacheDir, "experiential.db");
  if (existsSync(expPath)) {
    let edb: Awaited<ReturnType<typeof openDatabase>> | undefined;
    try {
      edb = await openDatabase(expPath);
      const c = edb
        .prepare(
          "SELECT COUNT(DISTINCT tool) AS d, COUNT(*) AS n, MIN(ts) AS lo, MAX(ts) AS hi FROM agent_episodes",
        )
        .get() as { d: number; n: number; lo: number | null; hi: number | null };
      out.tools = { distinctTools: c.d, episodes: c.n, firstAt: c.lo, lastAt: c.hi };
    } catch {
      /* no agent_episodes — stays null, i.e. NOT MEASURED, never 0 */
    } finally {
      try {
        edb?.close?.();
      } catch {
        /* see probeNotesFts */
      }
    }
  }
  return out;
}

// THE-521 — runtime health probe. Loads config, detects the environment (THE-522), runs the default
// check set, and emits either the versioned JSON envelope or human text rendered from it. Exits
// non-zero when any check fails, so scripts and CI can gate on health — a warning does not fail.
export async function run_doctor(cmd: Cmd<"doctor">): Promise<void> {
  const config = resolveOrUsageExit(cmd.configPath);
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
    ? await probeNotesFts(config.cacheDir)
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
        )
      : undefined;
  // The multi-vector gate is ONE decision that darkens two tables: chunk_sparse and chunk_colbert
  // are both written from embedFull, which only some providers emit. Mirrors the same expression
  // retrievalHeads uses below so doctor cannot disagree with itself about provider capability.
  const entryPoints = cmd.probe ? await probeEntryPoints(config.cacheDir) : undefined;
  const derivedTables = cmd.probe
    ? await probeDerivedTables(config.cacheDir, {
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
    ? await probeDerivedColumns(config.cacheDir, { experiential: experientialEnabled })
    : undefined;
  // THE-722: the reader audit_reports never had.
  const kbHealth = cmd.probe ? await probeKbHealth(config.cacheDir) : undefined;
  // THE-891 item 5: per-vault note-summary scan size, only under --probe (same contract as every
  // other store-touching probe above).
  const noteSummariesScale = cmd.probe
    ? await probeNoteSummariesScale(
        config.cacheDir,
        config.vaults.map((v) => v.id),
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
