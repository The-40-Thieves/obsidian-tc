// GH #995 / THE-1122 follow-up: PR #980 (1.31.4) changed embeddings.provider's DEFAULT from
// "ollama" to "local" when the `embeddings` block is absent, silently switching an unconfigured
// install to a different provider on upgrade and forcing a full in-process re-embed (reported: 4
// MCP client processes each spinning every core and ~1.1GB). This module is the ONE place that
// decides whether an unconfigured install should keep its EXISTING vault's provider ("sticky")
// instead of adopting the new default. Callers: runtime/server-runtime.ts (boot) and
// cli/commands/doctor-probes.ts (doctor's status surface) both call resolveStickyEmbeddings with
// the SAME inputs shape, so boot and doctor cannot disagree about the resolved provider.
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { tableExists } from "../db/introspect";
import type { Database } from "../db/types";
import { isEmbeddingsProviderExplicitOnConfig } from "./provider-explicit";

/** Schema defaults obsidian-tc shipped BEFORE PR #980 (1.31.3 and earlier) — see
 *  indexing-embeddings.schema.ts's git history (commit 47cb24f3^). Used as the FALLBACK identity
 *  when an existing install's active embeddings are detected but not reliably mapped back to a
 *  reconstructable provider config (mapStoredModelToProviderConfig below): "predates the default
 *  change, but not precisely what it was configured as" still means "don't silently switch it". */
export const PRE_1_31_4_DEFAULT_PROVIDER = "ollama";
export const PRE_1_31_4_DEFAULT_MODEL = "nomic-embed-text";
export const PRE_1_31_4_DEFAULT_DIMENSIONS = 768;

/** Provider names whose `EmbeddingProvider.id` (chunk_embeddings.model / vec_chunks.model) is the
 *  plain `${provider}:${model}` shape with no OTHER required field to rebuild the adapter.
 *  Excludes "local" (already the default), "openai-compatible" (requires an operator baseUrl),
 *  "model-tier" (nested dense/full config not recoverable from the id) and "module" (arbitrary
 *  operator-chosen id, no fixed shape). A stored id whose prefix is not here is UNMAPPABLE. */
const RECONSTRUCTABLE_PROVIDERS = new Set(["ollama", "openai", "voyage", "cohere", "bge-m3"]);

/** Parse a `chunk_embeddings.model` value back into a provider/model(/revision) triple
 *  reconstructable as a real embeddings config. Returns undefined — NEVER a guess — when the
 *  provider prefix is not in RECONSTRUCTABLE_PROVIDERS or the id isn't shaped `provider:model`.
 *  `withRevision` (embeddings/index.ts) appends `@${revision}` to the outermost id, so a stored id
 *  can be `provider:model@revision`; split it off here so re-applying it at construction doesn't
 *  double it (`model@revision@revision`). */
export function mapStoredModelToProviderConfig(
  storedModelId: string,
): { provider: string; model: string; revision?: string } | undefined {
  const sep = storedModelId.indexOf(":");
  if (sep <= 0) return undefined;
  const provider = storedModelId.slice(0, sep);
  let model = storedModelId.slice(sep + 1);
  if (model.length === 0 || !RECONSTRUCTABLE_PROVIDERS.has(provider)) return undefined;
  const at = model.lastIndexOf("@");
  if (at > 0) {
    const revision = model.slice(at + 1);
    model = model.slice(0, at);
    if (model.length === 0 || revision.length === 0) return undefined;
    return { provider, model, revision };
  }
  return { provider, model };
}

/** One row of `queryActiveEmbeddingModels`' result — the stored identity AND the width it was
 *  actually written at. dimensions is per-row, not implied by the model name (e.g.
 *  `mxbai-embed-large` at 1024 pre-1.31.4, `provider` never set) — carrying it lets
 *  resolveStickyEmbeddings honor the STORED width instead of an assumed historical one. */
export interface ActiveEmbeddingModel {
  model: string;
  dimensions: number;
}

/** The active (`is_active = 1`) `chunk_embeddings` rows for the given vaults, most frequently
 *  occurring model first — the SAME rule persist-note-plan.ts's THE-531 deactivateOld enforces on
 *  write. Empty when the cache db has no chunk_embeddings/chunks tables yet (a fresh install) or
 *  the caller names no vault. Scoped to `vaultIds` via a JOIN on chunks.vault_id: cache.db is
 *  shared across every vault a deployment registers, so an unscoped query would let one vault's
 *  provider choice leak into another's resolution. `MAX(e.dimensions)` is required by SQLite's
 *  GROUP BY even though a single `model` is written at one width by construction (PRIMARY KEY is
 *  (chunk_id, model); a different width writes a different model id, per THE-460 fix B) — never
 *  actually averaging across widths. */
export function queryActiveEmbeddingModels(
  db: Database,
  vaultIds: readonly string[],
): ActiveEmbeddingModel[] {
  if (vaultIds.length === 0) return [];
  if (!tableExists(db, "chunk_embeddings") || !tableExists(db, "chunks")) return [];
  const placeholders = vaultIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT e.model AS model, MAX(e.dimensions) AS dimensions, COUNT(*) AS n
       FROM chunk_embeddings e JOIN chunks c ON c.id = e.chunk_id
       WHERE e.is_active = 1 AND c.vault_id IN (${placeholders})
       GROUP BY e.model
       ORDER BY n DESC`,
    )
    .all(...vaultIds) as Array<{ model: string; dimensions: number; n: number }>;
  return rows.map((r) => ({ model: r.model, dimensions: r.dimensions }));
}

/**
 * `queryActiveEmbeddingModels` scopes strictly to the CURRENT `config.vaults[].id`s, a mutable
 * string with no path identity behind it in cache.db (no `vaults` table to join against). Two
 * failure directions follow: a renamed vault id orphans its own rows (that query returns [] and
 * resolution would silently adopt the new default), and a fresh vault reusing another vault's id
 * (zero-config default is always "main") would get pinned to that OTHER vault's provider. Neither
 * is fixable by better matching without a stable identity this codebase does not yet persist; this
 * function instead answers a narrower question — "does this cache db hold ACTIVE vectors under
 * some vault id this config does not currently name" — so resolveStickyEmbeddings can refuse to
 * resolve silently (source "ambiguous-orphaned-index") instead of guessing either direction. Only
 * meaningful when the vaultIds-scoped `queryActiveEmbeddingModels` result is already empty.
 */
export function hasOrphanedActiveEmbeddings(
  db: Database,
  configuredVaultIds: readonly string[],
): boolean {
  if (configuredVaultIds.length === 0) return false;
  if (!tableExists(db, "chunk_embeddings") || !tableExists(db, "chunks")) return false;
  const placeholders = configuredVaultIds.map(() => "?").join(",");
  const row = db
    .prepare(
      `SELECT 1 AS found
       FROM chunk_embeddings e JOIN chunks c ON c.id = e.chunk_id
       WHERE e.is_active = 1 AND c.vault_id NOT IN (${placeholders})
       LIMIT 1`,
    )
    .get(...configuredVaultIds) as { found: number } | undefined;
  return row !== undefined;
}

/**
 * THE-1122 review round 2 (finding 3): the row-returning counterpart of
 * `hasOrphanedActiveEmbeddings` above — same JOIN/scope, but returns each orphaned model's own
 * identity and width (most-frequent first), the shape `resolveStickyEmbeddings` needs to KEEP an
 * orphaned vault's provider instead of merely flagging that one exists. `hasOrphanedActiveEmbeddings`
 * stays as its own cheap `LIMIT 1` existence check for the ambiguity detection GATE
 * (`applyStickyEmbeddings` only pays for either query when the vaultIds-scoped
 * `queryActiveEmbeddingModels` result is already empty); this is the second query run only once
 * that gate is already true.
 */
export function queryOrphanedActiveEmbeddingModels(
  db: Database,
  configuredVaultIds: readonly string[],
): ActiveEmbeddingModel[] {
  if (configuredVaultIds.length === 0) return [];
  if (!tableExists(db, "chunk_embeddings") || !tableExists(db, "chunks")) return [];
  const placeholders = configuredVaultIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT e.model AS model, MAX(e.dimensions) AS dimensions, COUNT(*) AS n
       FROM chunk_embeddings e JOIN chunks c ON c.id = e.chunk_id
       WHERE e.is_active = 1 AND c.vault_id NOT IN (${placeholders})
       GROUP BY e.model
       ORDER BY n DESC`,
    )
    .all(...configuredVaultIds) as Array<{ model: string; dimensions: number; n: number }>;
  return rows.map((r) => ({ model: r.model, dimensions: r.dimensions }));
}

/** Where an effective embeddings.provider/.model/.dimensions value came from — surfaced (not just
 *  the resolved value) on every status/health surface that reports the provider, per GH #995's
 *  review: an operator must be able to tell "I configured this" apart from "the server kept this
 *  from my existing index" apart from "this is just the zero-config default". */
export type EmbeddingsProviderSource =
  | "configured"
  | "kept-from-index"
  | "default"
  /** No active row matched the CURRENT vault ids, but the cache db holds active vectors under
   *  some OTHER vault id — see hasOrphanedActiveEmbeddings. Resolves to `configured` (the schema
   *  default) but is surfaced distinctly so a caller never reads this as "nothing to be sticky
   *  about". */
  | "ambiguous-orphaned-index";

export interface StickyEmbeddingsInput {
  /** Whether `embeddings.provider` was set in the raw (pre-default) config — see
   *  config/load.ts's isEmbeddingsProviderExplicit. An explicit provider always wins, INCLUDING an
   *  explicit `"local"` — that IS the opt-in to switch. */
  providerExplicit: boolean;
  /** embeddings.onProviderChange — "keep" (default) applies this module's sticky resolution;
   *  "switch" adopts `configured` outright, same as a fresh install. */
  onProviderChange: "keep" | "switch";
  /** The schema-resolved (post-default) provider/model/dimensions — what a fresh install, or an
   *  operator who set onProviderChange: "switch", would use. */
  configured: { provider: string; model: string; dimensions: number };
  /** queryActiveEmbeddingModels's result — [] means "nothing matched the configured vault ids"
   *  (fresh install, OR a renamed/ambiguous vault id — see hasOrphanedActiveEmbeddings), ordered
   *  most-frequent-first. */
  activeModels: readonly ActiveEmbeddingModel[];
  /** `queryOrphanedActiveEmbeddingModels`'s result (most-frequent-first) — only consulted when
   *  `activeModels` is empty. THE-1122 review round 2 (finding 3): a renamed vault id's rows show
   *  up here, and this function now KEEPS the most-frequent non-default-family entry from this
   *  list exactly like it does for `activeModels`, rather than silently constructing the new
   *  default over real existing vectors. Absent/empty -> a genuinely fresh install, "default". */
  orphanedActiveModels?: readonly ActiveEmbeddingModel[];
}

export interface StickyEmbeddingsResolution {
  provider: string;
  model: string;
  dimensions: number;
  source: EmbeddingsProviderSource;
  /** Set only when the kept identity carried a model revision — see
   *  mapStoredModelToProviderConfig. Never set for the unmappable fallback (its substitute
   *  PRE_1_31_4_DEFAULT_* identity carries no revision of its own). */
  revision?: string;
  /** The raw chunk_embeddings.model value the resolution was kept from — only set when
   *  source === "kept-from-index". Carried for the boot/doctor notice text. */
  keptFromStoredModel?: string;
  /** True when source === "kept-from-index" but the stored model id could not be mapped to a
   *  reconstructable provider config (mapStoredModelToProviderConfig returned undefined) — the
   *  resolution fell back to the PRE_1_31_4_DEFAULT_* identity rather than guessing. */
  unmappableFallback?: boolean;
}

/**
 * THE-1122 review round 2 (finding 3): shared by the "this vault's own active rows" path and the
 * "orphaned rows under some OTHER vault id" path below — both need the SAME most-frequent
 * non-default-family lookup, unmappable fallback, and revision-split logic, so this is the one
 * place either is implemented. Returns undefined when every candidate already belongs to
 * `configuredProvider`'s own family — nothing left to keep sticky about — leaving the caller to
 * pick its own fallback source ("default" for the caller's own rows, an ambiguity-flagged
 * "nothing to keep" case for orphaned rows).
 */
function resolveKeptIdentity(
  storedModels: readonly ActiveEmbeddingModel[],
  configuredProvider: string,
  source: "kept-from-index" | "ambiguous-orphaned-index",
): StickyEmbeddingsResolution | undefined {
  const stored = storedModels.find(
    (m) => m.model !== configuredProvider && !m.model.startsWith(`${configuredProvider}:`),
  );
  if (stored === undefined) return undefined;
  const mapped = mapStoredModelToProviderConfig(stored.model);
  if (mapped === undefined) {
    return {
      provider: PRE_1_31_4_DEFAULT_PROVIDER,
      model: PRE_1_31_4_DEFAULT_MODEL,
      dimensions: PRE_1_31_4_DEFAULT_DIMENSIONS,
      source,
      keptFromStoredModel: stored.model,
      unmappableFallback: true,
    };
  }
  return {
    provider: mapped.provider,
    model: mapped.model,
    // The STORED row's own width, not an assumed historical default — a pre-1.31.4 config could
    // set `model`/`dimensions` explicitly (e.g. mxbai-embed-large at 1024) without ever setting
    // `provider`, and that width must survive or ensureVecChunks (search/vec.ts) drops/rebuilds
    // vec_chunks and excludes every stored vector from backfill.
    dimensions: stored.dimensions,
    source,
    keptFromStoredModel: stored.model,
    ...(mapped.revision !== undefined ? { revision: mapped.revision } : {}),
  };
}

/**
 * The ONE decision point for "what embeddings provider should an install actually use" — see this
 * module's header for why. Pure and synchronous: every input is already resolved (config
 * explicitness, the active-model list from the cache db) so this has no I/O of its own and is
 * trivially unit-testable.
 */
export function resolveStickyEmbeddings(input: StickyEmbeddingsInput): StickyEmbeddingsResolution {
  const { providerExplicit, onProviderChange, configured, activeModels } = input;
  if (providerExplicit) {
    return { ...configured, source: "configured" };
  }
  if (onProviderChange === "switch") {
    return { ...configured, source: "default" };
  }
  if (activeModels.length === 0) {
    // Empty could mean "fresh install" OR "this vault's rows are orphaned under a different vault
    // id in the same cache db" — the two cases this function cannot tell apart without a stable
    // identity (see hasOrphanedActiveEmbeddings). THE-1122 review round 2 (finding 3): an orphaned
    // vault id is NOT a fresh install — this cache db already holds real, non-default vectors, and
    // constructing the new default over them is the exact GH #995 failure this module exists to
    // close, reached through a renamed `vaults[].id` instead of an upgrade. So: keep the
    // most-frequent orphaned model's identity, the SAME rule the non-empty branch below applies to
    // this vault's own rows. Only when every orphaned row is already the current default's own
    // family (nothing to protect) — or there are no orphaned rows at all — does this fall through
    // without adopting a different identity.
    const orphaned = input.orphanedActiveModels ?? [];
    if (orphaned.length === 0) {
      return { ...configured, source: "default" };
    }
    const kept = resolveKeptIdentity(orphaned, configured.provider, "ambiguous-orphaned-index");
    return kept ?? { ...configured, source: "ambiguous-orphaned-index" };
  }
  // activeModels is ordered most-frequent-first. A GH #995 victim who ran 1.31.4 long enough to
  // re-embed most chunks under the current default before rolling back has a MIXED index with the
  // default's own family in the MAJORITY (activeModels[0]) — picking that entry blindly would
  // resolve to "default" and silently continue the switch they never chose. Instead, find the
  // most-frequent active model that does NOT already belong to the current default's provider
  // family; only when every active model is already that family is there nothing left to keep
  // sticky about.
  const kept = resolveKeptIdentity(activeModels, configured.provider, "kept-from-index");
  return kept ?? { ...configured, source: "default" };
}

/** The boot/doctor notice text for a "kept-from-index" resolution — undefined for every other
 *  source, so a caller can `if (notice) print(notice)` unconditionally. Pure formatter, same
 *  pattern as runtime/boot-notices.ts's formatStaleExplicitSessionNotice. */
export function formatStickyEmbeddingsNotice(
  resolution: StickyEmbeddingsResolution,
): string | undefined {
  if (resolution.source === "ambiguous-orphaned-index") {
    const base =
      "embeddings: could not confirm this vault's existing provider — embeddings.provider was not " +
      "set in config, no active vectors matched any currently configured vault id, but this cache " +
      "directory DOES hold active vectors under a DIFFERENT vault id. This can happen when a vault " +
      'was renamed (its old vault id\'s rows are now "orphaned"), or when a new vault reuses a ' +
      "shared cache directory.\n";
    // THE-1122 review round 2 (finding 3): the orphaned rows are already the current default's own
    // family (or there were none) — nothing to keep, so this reads exactly like a fresh install
    // except that the ambiguity is still worth naming.
    if (resolution.keptFromStoredModel === undefined) {
      return (
        base +
        "obsidian-tc found nothing to keep — the orphaned rows already belong to the default " +
        `provider's own family. Using "${resolution.provider}" for this run. If this vault was ` +
        "renamed, restore its original `id` (or point it at its original `cacheDir`) before " +
        "re-indexing; run `obsidian-tc doctor` to inspect the cache directory's stored providers.\n"
      );
    }
    const identity = resolution.unmappableFallback
      ? `provider "${resolution.provider}" (the pre-1.31.4 default — the orphaned stored model id ` +
        `"${resolution.keptFromStoredModel}" could not be mapped to a known provider, so ` +
        "obsidian-tc refused to guess)"
      : `provider "${resolution.provider}", model "${resolution.model}"` +
        (resolution.revision !== undefined ? `, revision "${resolution.revision}"` : "");
    return (
      base +
      `obsidian-tc kept ${identity} from those orphaned rows rather than silently switching this ` +
      "vault to the current default — this vault's OWN id matched nothing, so unless this vault " +
      "was renamed (in which case this is very likely correct), this may be the WRONG provider. " +
      "Resolve the ambiguity: restore this vault's original `id` (or `cacheDir`) if it was " +
      'renamed, or set embeddings.provider explicitly (or embeddings.onProviderChange: "switch") ' +
      "to take the current default outright. Run `obsidian-tc doctor` to inspect the cache " +
      "directory's stored providers.\n"
    );
  }
  if (resolution.source !== "kept-from-index") return undefined;
  const identity = resolution.unmappableFallback
    ? `provider "${resolution.provider}" (the pre-1.31.4 default — this vault's stored model id ` +
      `"${resolution.keptFromStoredModel}" could not be mapped to a known provider, so obsidian-tc ` +
      "refused to guess)"
    : `provider "${resolution.provider}", model "${resolution.model}"` +
      (resolution.revision !== undefined ? `, revision "${resolution.revision}"` : "");
  return (
    `embeddings: kept ${identity} from this vault's existing index — embeddings.provider was not ` +
    "set in config. obsidian-tc 1.31.4/1.31.5 silently switched an unconfigured install's provider " +
    'to "local" on upgrade, forcing a full in-process re-embed (GH #995); this version keeps your ' +
    "existing provider by default instead. To switch to the bundled local embedder, set " +
    'embeddings.provider: "local" (or embeddings.onProviderChange: "switch") in your config — either ' +
    "re-embeds the whole vault once.\n"
  );
}

/** The config slice resolveStickyEmbeddings/applyStickyEmbeddings need — a narrow structural type
 *  (not the full `ServerConfig`) so this module never needs to import the schema, matching the
 *  "isomorphic leaf, no cross-domain import" convention packages/shared's own schema files use. */
export interface StickyEmbeddingsConfigLike {
  embeddings: {
    provider: string;
    model: string;
    dimensions: number;
    onProviderChange: "keep" | "switch";
    revision?: string;
  };
  vaults: ReadonlyArray<{ id: string }>;
}

/**
 * The full glue: resolve, then mutate `config.embeddings` IN PLACE when the resolution kept a
 * different provider — the one call runtime/server-runtime.ts (boot) and
 * cli/commands/doctor-probes.ts's caller (doctor's status surface) each make, so both share
 * identical mutate-once semantics and cannot drift on when the mutation happens. Returns the
 * resolution so the caller can still print the boot/doctor notice (formatStickyEmbeddingsNotice).
 */
export function applyStickyEmbeddings<T extends StickyEmbeddingsConfigLike>(
  config: T,
  db: Database,
): StickyEmbeddingsResolution {
  // GH #995 fix round 2 (root cause, item A): read off the config object itself — see
  // embeddings/provider-explicit.ts's header. No caller passes this in anymore, so no caller can
  // forget to.
  const providerExplicit = isEmbeddingsProviderExplicitOnConfig(config.embeddings);
  const vaultIds = config.vaults.map((v) => v.id);
  const activeModels = queryActiveEmbeddingModels(db, vaultIds);
  const resolution = resolveStickyEmbeddings({
    providerExplicit,
    onProviderChange: config.embeddings.onProviderChange,
    configured: {
      provider: config.embeddings.provider,
      model: config.embeddings.model,
      dimensions: config.embeddings.dimensions,
    },
    activeModels,
    // Only worth a second query when the first came back empty — a non-empty scoped match never
    // needs the ambiguity check.
    orphanedActiveModels:
      activeModels.length === 0 ? queryOrphanedActiveEmbeddingModels(db, vaultIds) : [],
  });
  // THE-1122 review round 2 (finding 4): an UNMAPPABLE stored id (openai-compatible:...,
  // module:..., an unrecognized custom id) must never silently become a CONSTRUCTED "ollama@768"
  // provider — that guess is almost certainly wrong for anything but the real pre-1.31.4 default,
  // and ensureVecChunks would rebuild vec_chunks at the WRONG width and drop every real vector.
  // Fail construction closed, before any provider or vec DDL runs (every caller of this function
  // constructs a provider and/or touches vec_chunks immediately after), rather than build on a
  // guess. This is the smaller-safe-option this repo picked over adding a separate lexical-only
  // boot mode — see docs/src/content/docs/configuration/embeddings.md's upgrade section.
  if (resolution.unmappableFallback) {
    throw err.invalidInput(
      "embeddings.provider was not set in config, and this vault's existing index's stored model " +
        `id ("${resolution.keptFromStoredModel}") could not be mapped back to a real provider — ` +
        "refusing to guess and construct a provider that would silently rebuild your vector index " +
        "at the wrong width.",
      {
        keptFromStoredModel: resolution.keptFromStoredModel,
        source: resolution.source,
        hint:
          "set embeddings.provider (and embeddings.model / embeddings.dimensions) explicitly to " +
          `match what "${resolution.keptFromStoredModel}" was actually embedded with — run ` +
          "`obsidian-tc doctor` first if you are unsure which model/width that is.",
      },
    );
  }
  // Mutates for BOTH "kept-from-index" (this vault's own rows) and "ambiguous-orphaned-index" with
  // a resolvable identity (finding 3: a renamed vault id's rows) — `keptFromStoredModel` is only
  // ever set by resolveKeptIdentity, so its presence alone (not a source check) is the correct
  // gate for either case. An "ambiguous-orphaned-index" with nothing to keep (already
  // default-family, or no orphaned rows at all) correctly leaves config untouched.
  if (resolution.keptFromStoredModel !== undefined) {
    config.embeddings.provider = resolution.provider;
    config.embeddings.model = resolution.model;
    config.embeddings.dimensions = resolution.dimensions;
    if (resolution.revision !== undefined) config.embeddings.revision = resolution.revision;
  }
  return resolution;
}
