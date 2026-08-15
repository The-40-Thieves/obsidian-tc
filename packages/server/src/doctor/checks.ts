// THE-521 — the individual checks. Each is a factory taking injected inputs and returning a Check,
// so it is unit-testable with no live server, DB, or network.

import type { BridgeStateReport } from "../bridge";
import type { CapabilityProfile } from "../capability";
import type { EpisodeBacklog } from "../experiential/reflect";
import {
  type RerankerPreflightEmbeddings,
  rerankerBuildBlocker,
} from "../providers/reranker-preflight";
import type { NotesFtsIntegrity } from "../search/fts";
import type { Check, CheckStatus } from "./types";

/** #Final-review blocker 2: `embeddings.provider` and `reranker.provider` are open strings resolved
 *  against the provider registry at boot (embeddingsEntryOrThrow / resolveReranker); an unregistered
 *  name used to be rejected by `ServerConfigSchema.parse` and now parses cleanly. The ONLY thing
 *  that still catches it is the server's own boot path — doctor, whose entire job is finding
 *  misconfigurations, previously reported an unregistered name as "ready". `registered` is injected
 *  (not imported from providers/registry.ts here) so this check stays testable with no live
 *  registry, matching every other check in this file. */
export interface ProviderRegistrationView {
  embeddingsProvider: string;
  /** config.reranker?.provider — absent means no reranker block is configured, which is always valid
   *  and not checked here. */
  rerankerProvider?: string;
}

/** providers.registered — fails loudly, with the same registered-name list boot's own error would
 *  show, when either configured provider name is not in the registry. */
export function providerRegistrationCheck(
  view: ProviderRegistrationView,
  registered: { embeddings: string[]; reranker: string[] },
): Check {
  return {
    id: "providers.registered",
    category: "retrieval",
    run: () => {
      const details: Record<string, string> = { embeddings: view.embeddingsProvider };
      const issues: string[] = [];

      if (!registered.embeddings.includes(view.embeddingsProvider)) {
        details.embeddings = `${view.embeddingsProvider} (UNREGISTERED)`;
        issues.push(
          `embeddings.provider "${view.embeddingsProvider}" is not registered; set embeddings.provider to one of: ${registered.embeddings.join(", ")}`,
        );
      }

      if (view.rerankerProvider !== undefined) {
        details.reranker = view.rerankerProvider;
        if (!registered.reranker.includes(view.rerankerProvider)) {
          details.reranker = `${view.rerankerProvider} (UNREGISTERED)`;
          issues.push(
            `reranker.provider "${view.rerankerProvider}" is not registered; set reranker.provider to one of: ${registered.reranker.join(", ")}`,
          );
        }
      }

      if (issues.length > 0) {
        return {
          status: "fail",
          summary: `${issues.length} configured provider name(s) are not registered`,
          details,
          issues,
          remediation: issues.join(" "),
        };
      }
      return {
        status: "ok",
        summary: "embeddings.provider and reranker.provider (if configured) are registered",
        details,
      };
    },
  };
}

/** runtime.versions — server, runtime and native module, read from the capability profile. */
export function runtimeCheck(profile: CapabilityProfile): Check {
  return {
    id: "runtime.versions",
    category: "runtime",
    run: () => ({
      status: "ok",
      summary: `${profile.serverVersion} on ${profile.runtime.name} ${profile.runtime.version}`,
      details: {
        serverVersion: profile.serverVersion,
        runtime: `${profile.runtime.name} ${profile.runtime.version}`,
        nativeModule: String(profile.runtime.nativeModule),
      },
    }),
  };
}

/** native.availability — a warning (not a failure) when the accelerated module fell back to JS. */
export function nativeCheck(profile: CapabilityProfile): Check {
  return {
    id: "native.availability",
    category: "runtime",
    run: () =>
      profile.runtime.nativeModule
        ? { status: "ok", summary: "native acceleration module loaded" }
        : {
            status: "warning",
            summary: "native module not loaded — running on the JS fallback path",
            remediation:
              "Reinstall so the platform-native module builds, or ignore if the JS path is acceptable for this deployment.",
          },
  };
}

export interface AuthPolicy {
  mode: "none" | "jwt";
  tokenTtlSeconds: number;
  readOnly: boolean;
}

/** auth.policy — the effective auth posture from config. Warns loudly on mode "none". */
export function authPolicyCheck(policy: AuthPolicy): Check {
  return {
    id: "auth.policy",
    category: "auth",
    run: () => {
      const details = {
        mode: policy.mode,
        tokenTtlSeconds: String(policy.tokenTtlSeconds),
        readOnly: String(policy.readOnly),
      };
      if (policy.mode === "none") {
        return {
          status: "warning",
          summary: "auth.mode is none — every request resolves to full wildcard scopes",
          details,
          remediation:
            "Set auth.mode to jwt (with a jwtSecret or JWKS) before exposing this server.",
        };
      }
      return { status: "ok", summary: `auth.mode ${policy.mode}`, details };
    },
  };
}

/** A decoded token's time claims, in seconds since the epoch. */
export interface TokenClaims {
  iat: number;
  exp: number;
}

/**
 * auth.maxAge — THE-520. tokenTtlSeconds caps a token's AGE from `iat`, independently of `exp`. This
 * check makes the distinction explicit: it computes the max-age-derived expiry (iat + ttl) alongside
 * the token's own exp, reports WHICH one binds, and fails/warns when max-age is the earlier bound —
 * the exact silent-killer that read healthy at every other layer.
 *
 * With no token to inspect it degrades to an informational note stating the configured max age, since
 * the failure mode is invisible without a real token's iat.
 */
export function authMaxAgeCheck(
  policy: { tokenTtlSeconds: number },
  token: TokenClaims | undefined,
  nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
): Check {
  return {
    id: "auth.maxAge",
    category: "auth",
    run: () => {
      const ttl = policy.tokenTtlSeconds;
      if (!token) {
        return {
          status: "ok",
          summary: "no deployed token to inspect — reporting configured max age only",
          details: { tokenTtlSeconds: String(ttl) },
          notes: [
            "tokenTtlSeconds caps a token's AGE from its iat, independently of exp: a token with a far-future exp is still rejected once older than this. Supply a token to check the deployed credential.",
          ],
        };
      }

      const maxAgeExpiry = token.iat + ttl;
      const binding = maxAgeExpiry < token.exp ? "max-age" : "exp";
      const effectiveExpiry = Math.min(maxAgeExpiry, token.exp);
      const now = nowSeconds();
      const details = {
        bindingConstraint: binding,
        maxAgeExpiry: new Date(maxAgeExpiry * 1000).toISOString(),
        tokenExp: new Date(token.exp * 1000).toISOString(),
        effectiveExpiry: new Date(effectiveExpiry * 1000).toISOString(),
      };

      if (now >= effectiveExpiry) {
        const why =
          binding === "max-age"
            ? "token is past its MAX AGE (iat + tokenTtlSeconds) even though exp is still in the future"
            : "token is past its exp";
        return {
          status: "fail",
          summary: `deployed token is not valid: ${why}`,
          details,
          issues: [why],
          remediation:
            binding === "max-age"
              ? "Re-mint the token, or raise auth.tokenTtlSeconds to match the token's intended lifetime."
              : "Re-mint the token with a later exp.",
        };
      }

      if (binding === "max-age") {
        return {
          status: "warning",
          summary: "token is valid, but its max age will expire it well before its exp",
          details,
          remediation:
            "Raise auth.tokenTtlSeconds to at least the token's exp-minus-iat lifetime, or plan to re-mint before the max age.",
        };
      }

      return { status: "ok", summary: "token is within both its exp and its max age", details };
    },
  };
}

/** snapshots.policy (THE-648) — reports whether destructive-write snapshots (restore_note's undo)
 *  are captured. Enabled is the default posture as of THE-648, so it is unremarkable; explicitly
 *  disabled is a warning, since a delete/replace then has no built-in rollback. Retention is
 *  informational only — it is already pruned inline, so it never affects status. */
export function snapshotsCheck(view: { enabled: boolean; retention: number }): Check {
  return {
    id: "snapshots.policy",
    category: "notes",
    run: () => {
      const details = { enabled: String(view.enabled), retention: String(view.retention) };
      if (!view.enabled) {
        return {
          status: "warning",
          summary: "snapshots.enabled is false — destructive note writes have no built-in rollback",
          details,
          remediation:
            "Set snapshots.enabled: true (the default) to let restore_note undo a destructive write, or leave disabled if that trade-off is intentional.",
        };
      }
      return {
        status: "ok",
        summary: `snapshots enabled, keeping the newest ${view.retention} version(s) per note`,
        details,
      };
    },
  };
}

/** bridge.state (THE-523) — per-vault live/headless/degraded with reasons. A degraded vault (version
 *  skew, or the previously-invisible enabled-but-unreachable) is a warning with actionable
 *  remediation; live and headless are both healthy states. */
export function bridgeCheck(reports: { vaultId: string; report: BridgeStateReport }[]): Check {
  return {
    id: "bridge.state",
    category: "bridge",
    run: () => {
      const details: Record<string, string> = {};
      for (const { vaultId, report } of reports) {
        details[vaultId] = `${report.state} (${report.reason})`;
      }
      const degraded = reports.filter((r) => r.report.state === "degraded");
      if (degraded.length > 0) {
        const first = degraded[0];
        return {
          status: "warning",
          summary: `${degraded.length} vault(s) degraded: ${degraded.map((d) => `${d.vaultId} [${d.report.reason}]`).join(", ")}`,
          details,
          ...(first?.report.remediation ? { remediation: first.report.remediation } : {}),
        };
      }
      return {
        status: "ok",
        summary:
          reports.length === 0
            ? "no vaults configured"
            : `${reports.length} vault(s): ${reports.map((r) => `${r.vaultId}=${r.report.state}`).join(", ")}`,
        details,
      };
    },
  };
}

/** obsidian detection — surfaces what THE-522 found. No install is a supported state, not a failure. */
export function obsidianCheck(profile: CapabilityProfile): Check {
  return {
    id: "obsidian.detection",
    category: "obsidian",
    run: () => {
      const { installed, vaults } = profile.obsidian;
      if (!installed && vaults.length === 0) {
        return {
          status: "ok",
          summary: "no Obsidian install detected (headless/server mode)",
          notes: [
            "No Obsidian registry found — this is a supported state. Add vaults explicitly in config.",
          ],
        };
      }
      const names = vaults.map((v) => v.name);
      const withRest = vaults.filter((v) =>
        v.plugins.installed.some((p) => p.id === "obsidian-local-rest-api" && p.enabled),
      ).length;
      return {
        status: "ok",
        summary: `detected ${vaults.length} vault(s): ${names.join(", ")}`,
        details: {
          vaults: String(vaults.length),
          vaultNames: names,
          localRestApiEnabled: `${withRest}/${vaults.length}`,
        },
      };
    },
  };
}

/** THE-679 view: enough to answer "would this declared reranker block build?" without executing
 *  anything. Absent `rerankerProvider` means no block is declared, which is always fine. */
export interface RerankerBuildableView {
  rerankerProvider?: string;
  rerankerBaseUrl?: string;
  embeddings?: RerankerPreflightEmbeddings;
  gatewayUrlEnv?: string;
}

/**
 * THE-679. `providers.registered` validates provider NAMES; this validates that a declared block
 * can actually be BUILT.
 *
 * The gap it closes: a config naming "model-tier" without `embeddings.modelTier.full`, or "gateway"
 * with no base URL, hard-fails boot — while doctor reported ok and exited 0, because both are
 * perfectly valid names. Doctor was silent about the one configuration guaranteed not to start.
 *
 * Shares `rerankerBuildBlocker` with runtime/tool-wiring.ts so the pre-boot verdict and the
 * boot-time throw cannot drift. Offline by construction: a `module` provider is NEVER probed here,
 * because diagnosing must not execute operator-supplied code.
 */
export function rerankerBuildableCheck(view: RerankerBuildableView): Check {
  return {
    id: "reranker.buildable",
    category: "retrieval",
    run: () => {
      if (view.rerankerProvider === undefined) {
        return {
          status: "ok" as CheckStatus,
          summary: "reranker: no block declared (default precedence applies)",
        };
      }
      const blocker = rerankerBuildBlocker(view.rerankerProvider, view.embeddings, {
        baseUrl: view.rerankerBaseUrl,
        gatewayUrlEnv: view.gatewayUrlEnv,
      });
      if (blocker === null) {
        return {
          status: "ok" as CheckStatus,
          summary: `reranker: "${view.rerankerProvider}" has no known build blocker`,
          details: { provider: view.rerankerProvider },
        };
      }
      return {
        status: "fail" as CheckStatus,
        summary: blocker.reason,
        details: { provider: view.rerankerProvider },
        remediation: blocker.hint,
      };
    },
  };
}

/** THE-696: inputs for the notes_fts soundness check. `ftsEnabled` mirrors what health reports —
 *  availability — and `probe` is the opt-in that can actually contradict it. Sync, unlike the dense
 *  probe: this one runs a local SQLite command, so making it async would buy nothing and would
 *  imply a network round-trip that does not happen. */
export interface NotesFtsView {
  /** FTS5 available on the connection (OBSIDIAN_TC_DISABLE_FTS unset, adapter built with FTS5). */
  ftsEnabled: boolean;
  /** THE-696: OPT-IN integrity probe, supplied only under `doctor --probe`. Absent by default —
   *  integrity-check costs ~0.6s on a 1,146-note trigram index, and diagnosing must not acquire a
   *  cost (or a side effect) just because someone ran it. */
  probe?: () => NotesFtsIntegrity;
}

/**
 * search.notes_fts — is the note-level lexical index SOUND, not merely present?
 *
 * THE-688 drew this distinction for the embeddings provider; it was never applied here.
 * `health.fts_enabled` is documented as "True when FTS5 (notes_fts) is AVAILABLE on this
 * connection" and stayed true for the entire period the live index was malformed. The index kept
 * answering MATCH queries with plausible counts — measured, a corrupted copy returned identical
 * counts to a healthy one on every term tried — so nothing downstream could notice either.
 *
 * A malformed index is a WARNING, not a fail. The server boots, and chunk-level retrieval
 * (knowledge_search / vault_graph_search, which ride chunk_fts) is unaffected. What degrades is the
 * note-level lexical surface: search_text, find_notes_by_*, list_tags.
 */
export function notesFtsIntegrityCheck(view: NotesFtsView): Check {
  return {
    id: "search.notes_fts",
    category: "retrieval",
    run: async () => {
      // Not a fault: OBSIDIAN_TC_DISABLE_FTS=1 and an adapter without FTS5 are both supported, and
      // the query layer falls back to disk scans. Reporting that as unsound would be a false alarm
      // for a deliberate configuration.
      if (!view.ftsEnabled) {
        return {
          status: "ok" as CheckStatus,
          summary: "notes_fts: off — note-level lexical search falls back to disk scans",
          details: { notes_fts: "off (FTS5 unavailable or OBSIDIAN_TC_DISABLE_FTS=1)" },
        };
      }
      // THE-688 wording rule: the default branch says what it can support and no more. Provisioning
      // is an EXISTENCE fact (CREATE VIRTUAL TABLE IF NOT EXISTS); soundness needs a look.
      if (!view.probe) {
        return {
          status: "ok" as CheckStatus,
          summary: "notes_fts (from CONFIG, not probed): provisioned",
          details: { notes_fts: "provisioned — not verified (run `doctor --probe`)" },
        };
      }
      const probed = view.probe();
      if (probed.ok) {
        return {
          status: "ok" as CheckStatus,
          summary: "notes_fts: SOUND — FTS5 integrity-check passed",
          details: { notes_fts: "SOUND — probed, FTS5 integrity-check passed" },
        };
      }
      return {
        status: "warning" as CheckStatus,
        summary: "notes_fts is MALFORMED — note-level lexical search may be silently incomplete",
        details: { notes_fts: `MALFORMED — ${probed.reason}` },
        issues: [
          `the notes_fts inverted index failed FTS5 integrity-check: ${probed.reason}. It will keep answering MATCH queries, so search_text / find_notes_by_* / list_tags may be returning incomplete results with no error.`,
        ],
        remediation:
          "Rebuild the derived index: `INSERT INTO notes_fts(notes_fts) VALUES('rebuild');` against cache.db, or set OBSIDIAN_TC_VERIFY_FTS=1 so the next boot detects and repairs it. Nothing is lost — notes_fts is fully derived from the notes table. If it recurs after a rebuild, suspect unclean container shutdown.",
      };
    },
  };
}

/** THE-698: inputs for the experiential-evaluator check. Same opt-in probe shape as the notes_fts
 *  check — the ticket asked for one mechanism for this class of signal, not two. */
export interface ExperientialEvaluatorView {
  /** The experiential store is open (config.experiential.captureEpisodes et al.). */
  enabled: boolean;
  /** OPT-IN backlog count, supplied only under `doctor --probe`. */
  probe?: () => EpisodeBacklog;
}

/** Older than this and the evaluator cannot merely be "between ticks" — it is not running. The
 *  maintenance cadence is minutes; a day is generous by orders of magnitude, deliberately, so this
 *  never cries wolf on a healthy deployment that just captured a burst of episodes. */
const STALE_PROMOTABLE_MS = 86_400_000;

/**
 * experiential.evaluator — is the pending -> eligible promotion pass actually running?
 *
 * `evaluateEpisodes` had no scheduled caller: only the manual `obsidian-tc reflect` CLI. On the
 * live deployment that left 337 of 337 episodes `pending` across seventeen days, and `work_search`
 * — which serves evaluator-approved rows only, by security contract — returned zero rows every
 * time. Nothing reported it, because an honest-empty result is indistinguishable from "nothing
 * matched". SECURITY.md meanwhile documents `pending` as "a short-lived state and not a
 * quarantine", which the deployment quietly contradicted.
 *
 * A warning, not a fail: capture still works, nothing is lost, and the rows promote as soon as the
 * pass runs. What is broken is recall.
 */
export function experientialEvaluatorCheck(view: ExperientialEvaluatorView): Check {
  return {
    id: "experiential.evaluator",
    category: "retrieval",
    run: async () => {
      if (!view.enabled) {
        return {
          status: "ok" as CheckStatus,
          summary: "experiential evaluator: off — episode capture is not enabled",
          details: { evaluator: "off (experiential store closed)" },
        };
      }
      if (!view.probe) {
        return {
          status: "ok" as CheckStatus,
          summary: "experiential evaluator (from CONFIG, not probed): scheduled",
          details: { evaluator: "scheduled — backlog not counted (run `doctor --probe`)" },
        };
      }
      const b = view.probe();
      const detail = `${b.pending} pending (${b.promotable} promotable), ${b.eligible} eligible`;
      // Keys on PROMOTABLE age, never on the pending count. Two reasons, both load-bearing:
      // rows are born pending and legitimately wait for the next tick, and held rows (a
      // contradictory ok/error cluster, or a known-bad outcome) are supposed to stay pending
      // FOREVER. On the live store this exact check keyed on `pending` and warned immediately
      // after a successful promotion — 333 eligible, 4 permanently held — which is the health
      // check crying wolf about its own success.
      if (b.oldestPromotableAgeMs === null || b.oldestPromotableAgeMs < STALE_PROMOTABLE_MS) {
        return {
          status: "ok" as CheckStatus,
          summary: `experiential evaluator: ${detail}`,
          details: {
            evaluator:
              b.pending > 0 && b.promotable === 0
                ? `${detail} — nothing promotable; the remaining pending rows are held for cause`
                : `${detail} — backlog within one evaluation cycle`,
          },
        };
      }
      const days = Math.floor(b.oldestPromotableAgeMs / 86_400_000);
      return {
        status: "warning" as CheckStatus,
        summary: `the episode evaluator has not run: ${b.promotable} promotable, oldest ${days}d`,
        details: { evaluator: `STALE — ${detail}, oldest promotable ${days}d` },
        issues: [
          `${b.promotable} episode(s) are eligible for promotion under the deterministic rules but are still 'pending', and the oldest is ${days} day(s) old — far past any evaluation cycle. work_search serves evaluator-approved (eligible) rows only, so it is returning little or nothing, which is indistinguishable from "no episodes matched".`,
        ],
        remediation:
          "Run `obsidian-tc reflect` to promote the backlog, and confirm the server is on a build that schedules `episode-evaluation` (THE-698). Do NOT work around this by making work_search include pending rows: 'pending' means unevaluated, and the eligible-only contract is the security boundary.",
      };
    },
  };
}

/** One derived table's observed state, as the caller measured it. */
export interface DerivedTableState {
  /** Table name, qualified by store when ambiguous (e.g. "experiential.preference_profile"). */
  table: string;
  /** Rows present now. */
  rows: number;
  /**
   * Whether anything is in a position to write this table in THIS deployment:
   *  - "enabled"   — a BACKGROUND/automatic writer should be filling it. Empty means broken.
   *  - "on-demand" — only an explicit user or client action writes it. Empty means never used,
   *                  which is a fact worth reporting but is NOT a defect.
   *  - "disabled"  — a writer exists but its feature is off by config. Empty is EXPECTED.
   *  - "none"      — no code path writes this table at all. Empty is structural, not a setting.
   *
   * The enabled/on-demand split is what keeps this check credible. A first pass classified
   * `capture_queue`, `note_snapshots` and `forget_log` as "enabled", which produced eleven
   * warnings on a healthy deployment — "nobody has ever deleted a note" is true and useless. A
   * check that warns about correct behaviour gets muted, and then it is worth nothing when it is
   * finally right.
   */
  writer: "enabled" | "on-demand" | "disabled" | "none";
  /** The lever: what would turn the writer on, or why there isn't one. Shown in remediation. */
  lever: string;
}

export interface DerivedTablesView {
  /** Attached only under `--probe`, matching every other probing check: the default run stays
   *  offline and does not touch either store. */
  probe?: () => DerivedTableState[];
}

/**
 * derived.liveness — is each derived table actually being written, or is it silently empty?
 *
 * The gap this closes: a feature can have a config key, a migration, an implementation and passing
 * tests, and still have never written a row in this deployment — and nothing reports that.
 * THE-692 (`maxPerCluster`: config key, implementation, tests, zero chunks ever capped), THE-688
 * (`doctor` printing `dense: ready` as an unconditional literal) and THE-714 (`workspace_sessions`
 * empty across 2,352 tool calls) are three instances of one shape. A census on 2026-08-03 found
 * four more empty derived tables in production, none of them visible from inside the system.
 *
 * CLASSIFICATION IS THE WHOLE POINT — a bare "this table is empty" check would cry wolf, exactly as
 * `experiential.evaluator` did when it keyed on pending count instead of promotable age. Empty is
 * only a finding when something was supposed to be writing:
 *
 *   rows > 0                  -> live      (ok)
 *   rows = 0, writer disabled -> off       (ok — the feature is switched off, this is expected)
 *   rows = 0, writer enabled  -> SILENT    (warning — configured, never wrote)
 *   rows = 0, writer none     -> UNWRITTEN (warning — nothing can write it; THE-629's shape)
 *
 * A warning, never a fail: an empty derived table breaks no request in flight. What it breaks is
 * the assumption that a shipped feature is a working one.
 */
export function derivedTablesCheck(view: DerivedTablesView): Check {
  return {
    id: "derived.liveness",
    category: "retrieval",
    run: () => {
      if (!view.probe) {
        return {
          status: "ok" as CheckStatus,
          summary: "derived tables (not probed): run `doctor --probe` to count rows",
          details: { liveness: "not probed" },
        };
      }
      const states = view.probe();
      if (states.length === 0) {
        return {
          status: "ok" as CheckStatus,
          summary: "derived tables: no store open to inspect",
          details: { liveness: "no store" },
        };
      }
      const live = states.filter((s) => s.rows > 0);
      const off = states.filter((s) => s.rows === 0 && s.writer === "disabled");
      const unused = states.filter((s) => s.rows === 0 && s.writer === "on-demand");
      const silent = states.filter((s) => s.rows === 0 && s.writer === "enabled");
      const unwritten = states.filter((s) => s.rows === 0 && s.writer === "none");

      const details: Record<string, string | string[]> = {
        live: live.map((s) => `${s.table}=${s.rows}`),
        off: off.map((s) => s.table),
      };
      // Reported, never warned on: an on-demand table with no rows is a feature awaiting its first
      // use, not a fault. Surfacing it still matters — it is how you learn a verb is unexercised.
      if (unused.length > 0) details.neverUsed = unused.map((s) => s.table);
      if (silent.length > 0) details.silent = silent.map((s) => `${s.table} (${s.lever})`);
      if (unwritten.length > 0) details.unwritten = unwritten.map((s) => `${s.table} (${s.lever})`);

      if (silent.length === 0 && unwritten.length === 0) {
        return {
          status: "ok" as CheckStatus,
          summary: `derived tables: ${live.length} written, ${off.length} off by config, ${unused.length} awaiting first use`,
          details,
        };
      }
      const issues = [
        ...silent.map(
          (s) => `${s.table}: writer is ENABLED but the table is empty — it has never written`,
        ),
        ...unwritten.map((s) => `${s.table}: no code path writes this table`),
      ];
      return {
        status: "warning" as CheckStatus,
        summary: `derived tables: ${silent.length} configured-but-empty, ${unwritten.length} with no writer (${live.length} written)`,
        details,
        issues,
        remediation:
          "For each table listed under `silent`, the named lever is what should have written it — confirm the feature is genuinely exercised rather than merely switched on. For `unwritten`, there is no writer to enable: either build the producer or stop shipping the consumer. An empty derived table is not itself an outage, but every consumer of it is returning honest-empty results that read like real ones.",
      };
    },
  };
}

// The two liveness counterparts live in their own modules — this file is dense against biome's
// 700-line ceiling — re-exported so the doctor surface stays one import. THE-720 asks "is the
// SIGNAL written" where the check above asks "is the TABLE written"; THE-722 is the read surface
// audit_reports never had. Each module's header carries the measurement that motivated it.
export {
  type DerivedColumnState,
  type DerivedColumnsView,
  derivedColumnsCheck,
} from "./column-liveness";
export {
  type KbHealthProbe,
  type KbHealthVault,
  type KbHealthView,
  kbHealthCheck,
} from "./kb-health";
