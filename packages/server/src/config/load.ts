import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  err,
  LOCAL_CATALOG_DIMENSIONS,
  type ServerConfig,
  ServerConfigSchema,
} from "@the-40-thieves/obsidian-tc-shared";
import { applySecurityProfile } from "./security-profile";

/**
 * Apply environment-secret overlays (kept off disk) to a raw config object and
 * validate it against the schema. Shared by file loading and zero-config startup.
 */
/**
 * Overlay environment-supplied values onto a raw config object, in place.
 *
 * THE-518: exported and `env`-injectable because `config/explain.ts` must apply the EXACT same
 * overlay to attribute provenance. A second copy over there would be a hand-kept duplicate of a
 * hand-written list — the drift this repo keeps finding — so there is one implementation and
 * explain calls it.
 *
 * plur endpoint/token may come from the environment to keep the engram-store bearer off disk (same
 * pattern as the JWT secret). The token is only ever placed in the Authorization header by the
 * bridge transport, never logged.
 */
export function applyEnvOverlays(
  raw: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env,
): Record<string, unknown> {
  const envSecret = env.OBSIDIAN_TC_JWT_SECRET;
  if (envSecret) {
    const auth = (raw.auth as Record<string, unknown> | undefined) ?? {};
    raw.auth = { ...auth, jwtSecret: envSecret };
  }
  const plurEndpoint = env.OBSIDIAN_TC_PLUR_ENDPOINT;
  const plurToken = env.OBSIDIAN_TC_PLUR_TOKEN;
  if (plurEndpoint || plurToken) {
    const plur = (raw.plur as Record<string, unknown> | undefined) ?? {};
    raw.plur = {
      ...plur,
      ...(plurEndpoint ? { endpoint: plurEndpoint } : {}),
      ...(plurToken ? { apiKey: plurToken } : {}),
    };
  }
  return raw;
}

/**
 * THE-825: whether `plane.enabled` was set explicitly in the RAW (pre-default, pre-validation)
 * config object, as opposed to being absent and defaulted by Zod's `.default(false)`. The two are
 * indistinguishable once `ServerConfigSchema.parse` has run -- an absent key and an explicit
 * `false` both resolve to `plane.enabled === false` -- so this must read the object BEFORE that
 * parse, the same raw object `finalizeConfig` is given. Neither the env overlay nor the security
 * profile touches `plane` (see applyEnvOverlays / security-profile.ts's HARDENED_BASE), so the raw
 * file object alone is the complete answer -- no precedence chain to resolve, unlike explain.ts.
 */
export function isPlaneEnabledExplicit(raw: Record<string, unknown>): boolean {
  const plane = raw.plane;
  return typeof plane === "object" && plane !== null && !Array.isArray(plane) && "enabled" in plane;
}

/** THE-1122 review: same "read the RAW pre-parse object" pattern as isPlaneEnabledExplicit above,
 *  for the same reason — `embeddings.model`/`.dimensions` both moved from an unconditional Zod
 *  default to a PLAIN one (indexing-embeddings.schema.ts's own comment explains why a
 *  provider-conditional schema-level default broke docgen), so `{"provider":"ollama"}` with no
 *  `model` now parses to the "local" provider's default model/dims rather than the historical
 *  Ollama pairing. That is WRONG specifically for `provider: "ollama"`: an operator who wrote that
 *  one field relying on the OLD schema default (this repo's own zero-config-smoke.ts did exactly
 *  this) gets a model name Ollama was never asked to pull. finalizeConfig below restores the
 *  historical pairing for that one case, post-parse — never touching any other provider's
 *  behaviour, and never touching a config that named its own `model` explicitly. */
export function isEmbeddingsModelExplicit(raw: Record<string, unknown>): boolean {
  const embeddings = raw.embeddings;
  return (
    typeof embeddings === "object" &&
    embeddings !== null &&
    !Array.isArray(embeddings) &&
    "model" in embeddings
  );
}

/** THE-1122 review (item 7): same "read the RAW pre-parse object" pattern as
 *  isEmbeddingsModelExplicit above, so a config that omits `dimensions` (letting the schema's own
 *  provider-agnostic 768 default apply) is distinguishable from one that explicitly asked for 768
 *  — the two must be handled differently for `provider: "local"` (see finalizeConfig below). */
export function isEmbeddingsDimensionsExplicit(raw: Record<string, unknown>): boolean {
  const embeddings = raw.embeddings;
  return (
    typeof embeddings === "object" &&
    embeddings !== null &&
    !Array.isArray(embeddings) &&
    "dimensions" in embeddings
  );
}

/** THE-1122 review round 3: same "read the RAW pre-parse object" pattern as the two functions
 *  above. `cacheDir` has a schema-level default (`.obsidian-tc`, anchored to the home directory
 *  below) — every OTHER provider tolerates that default silently, but `provider: "local"` cannot:
 *  its model cache lives under `<cacheDir>/models/embedder-local/`, and a config that never named
 *  where that should live is far more likely a genuine oversight (the operator wrote out an
 *  explicit `embeddings` block but forgot this one adjacent field) than an intentional "use
 *  whatever the default happens to be" — see finalizeConfig's own enforcement below. */
export function isCacheDirExplicit(raw: Record<string, unknown>): boolean {
  return "cacheDir" in raw;
}

/** Parse a config file's raw JSON (BOM-stripped, THE-185), before any overlay or schema default
 *  is applied. Exported so a caller can inspect what the file itself said -- e.g.
 *  `isPlaneEnabledExplicit` -- without re-implementing this read. */
export function readConfigFile(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
}

export function finalizeConfig(
  raw: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env,
): ServerConfig {
  applyEnvOverlays(raw, env);
  // THE-1122 review: captured BEFORE parsing — applySecurityProfile/ServerConfigSchema.parse both
  // leave `embeddings` untouched (verified: neither references it), so reading `raw` here or after
  // either call is equivalent, but doing it here matches isPlaneEnabledExplicit's own convention.
  const embeddingsModelWasExplicit = isEmbeddingsModelExplicit(raw);
  const embeddingsDimensionsWasExplicit = isEmbeddingsDimensionsExplicit(raw);
  const cacheDirWasExplicit = isCacheDirExplicit(raw);
  // THE-526: expand a named security profile into its field set BEFORE validation, so explicit fields
  // still override it and the result validates as a normal config.
  const config = ServerConfigSchema.parse(applySecurityProfile(raw));
  // THE-1122 review: `provider: "ollama"` with no explicit `model` restores the HISTORICAL pairing
  // (schema-level defaults are provider-agnostic now — see isEmbeddingsModelExplicit's own doc
  // comment for why). Every other provider is unaffected, and an explicit `model` is never
  // overridden regardless of provider.
  if (config.embeddings.provider === "ollama" && !embeddingsModelWasExplicit) {
    config.embeddings.model = "nomic-embed-text";
    config.embeddings.dimensions = 768;
  }
  // THE-1122 review (item 7): the schema's `dimensions` default (768) is likewise provider-agnostic
  // — see LOCAL_CATALOG_DIMENSIONS's own doc comment for why it cannot be provider-conditional at
  // the schema level. Without this, `{"provider":"local","model":"all-MiniLM-L6-v2"}` (a 384-dim
  // catalog entry) with no explicit `dimensions` silently inherits the WRONG width (768) and fails
  // far away, at vec0 column-width mismatch — this derives the real width instead. An unrecognized
  // `model` name is left alone here (embedder-local's own resolution refuses it with the supported
  // list; this fix only has data for the three real catalog entries).
  //
  // `embeddings.truncate: true` is a legitimate reason for an explicit `dimensions` NARROWER than
  // the catalog's native width (Matryoshka/MRL truncation — see that field's own doc comment), so
  // only a mismatch truncate cannot explain is rejected: WIDER than native (impossible to produce
  // by truncating), or any mismatch at all when truncate is off.
  if (config.embeddings.provider === "local") {
    const catalogDimensions = LOCAL_CATALOG_DIMENSIONS[config.embeddings.model];
    if (catalogDimensions !== undefined) {
      if (!embeddingsDimensionsWasExplicit) {
        config.embeddings.dimensions = catalogDimensions;
      } else {
        const configured = config.embeddings.dimensions;
        const explainedByTruncation = config.embeddings.truncate && configured <= catalogDimensions;
        if (configured !== catalogDimensions && !explainedByTruncation) {
          throw err.invalidInput(
            `embeddings.dimensions (${configured}) does not match embeddings.model ` +
              `"${config.embeddings.model}"'s native width (${catalogDimensions})`,
            {
              provider: "local",
              model: config.embeddings.model,
              configuredDimensions: configured,
              catalogDimensions,
              hint:
                "remove embeddings.dimensions to let it default to the model's native width, set " +
                `it to ${catalogDimensions} explicitly, or — if you intend Matryoshka (MRL) ` +
                `truncation — also set embeddings.truncate: true with dimensions <= ${catalogDimensions}. ` +
                "A mismatch reaching vec0 column creation instead fails with a far less actionable error.",
            },
          );
        }
      }
    }
  }
  // THE-1122 review round 3: `provider: "local"` (explicit OR the resolved schema default) must
  // name its own cacheDir — the provider factory (buildLocalEmbeddingProvider) already fails
  // closed when ctx.cacheDir is absent, but config LOAD itself never asked, so that failure only
  // ever surfaced far later, at first embed, with a caller-specific error instead of one naming
  // the actual config problem. `configFromVaultPath` (the true zero-config CLI front door: a bare
  // vault directory, no config file at all) supplies an explicit cacheDir itself for exactly this
  // reason — it is not exempt from this check, it just never trips it.
  if (config.embeddings.provider === "local" && !cacheDirWasExplicit) {
    throw err.invalidInput(
      'embeddings.provider "local" (explicit or the default when the embeddings block is ' +
        "absent) requires cacheDir to be set",
      {
        provider: "local",
        hint:
          'set "cacheDir" in your config (e.g. "~/.obsidian-tc" or an absolute path) — the local ' +
          "embedder's model cache lives under <cacheDir>/models/embedder-local/, and this must be " +
          "named explicitly rather than silently defaulted for this provider.",
      },
    );
  }
  // The cacheDir default (".obsidian-tc") is relative, so cli.ts mkdir's it against the process
  // CWD, which breaks when a GUI launcher spawns the server in a non-writable directory: Claude
  // Desktop starts MCP servers in C:\WINDOWS\system32, so `mkdir .obsidian-tc` is EPERM at boot
  // (a terminal only worked because its CWD was the vault). Anchor a relative cacheDir to the
  // user's home so it is absolute and CWD-independent; the shared cache.db isolates vaults by
  // vault_id, so one machine-local dir is correct. An explicit absolute cacheDir is honored as-is.
  if (!isAbsolute(config.cacheDir)) config.cacheDir = join(homedir(), config.cacheDir);
  return config;
}

/**
 * Load and validate server config from a JSON file. The JWT secret may be
 * supplied via OBSIDIAN_TC_JWT_SECRET to keep it out of the file on disk.
 */
export function loadConfig(path: string): ServerConfig {
  return finalizeConfig(readConfigFile(path));
}
