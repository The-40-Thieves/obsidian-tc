import { readFileSync, statSync } from "node:fs";
import { explainConfig, formatConfigError } from "../../config/explain";
import { finalizeConfig, isEmbeddingsProviderExplicit } from "../../config/load";
import type { Cmd } from "../shared";
import { resolveEffectiveEmbeddings } from "./doctor-probes";

// THE-518: trace every resolved config value to its origin. Reads the file itself rather than
// going through resolveServeConfig, because the RAW file object is the evidence for what the file
// (as opposed to the schema, the profile, or the environment) actually said.
export async function run_config_explain(cmd: Cmd<"config-explain">): Promise<void> {
  const path = cmd.configPath ?? process.env.OBSIDIAN_TC_CONFIG;
  if (!path) {
    process.stderr.write("config explain: pass a config.json (or set OBSIDIAN_TC_CONFIG).\n");
    process.exit(2);
  }
  let raw: Record<string, unknown>;
  try {
    // A DIRECTORY is the zero-config startup mode (resolveServeConfig synthesizes a config from
    // the vault path). There is no file to attribute values to, and labelling synthesized values
    // "file" would point the reader at a file that does not exist — so this refuses rather than
    // reports a provenance it cannot stand behind.
    if (statSync(path).isDirectory()) {
      process.stderr.write(
        `config explain: ${path} is a vault folder, not a config file. Zero-config startup has no ` +
          "config file to trace — every value is a schema default or derived from the vault path. " +
          "Point at a config.json to trace overrides.\n",
      );
      process.exit(2);
    }
    raw = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
  } catch (e) {
    process.stderr.write(`cannot read config at ${path}: ${e instanceof Error ? e.message : e}\n`);
    process.exit(2);
  }
  let explained: ReturnType<typeof explainConfig>;
  try {
    explained = explainConfig(raw);
  } catch (e) {
    // "Fails fast with a clear diagnostic" — one line per problem, not a zod blob.
    process.stderr.write(`${formatConfigError(e)}\n`);
    process.exit(2);
  }

  // GH #995 fix round 2 (finding 5): the EFFECTIVE embeddings identity, as its own synthetic row
  // — never folded into the real `embeddings.provider` entry above, whose file/default/env/profile
  // attribution must keep meaning "what the FILE said", not "what boot would resolve". Reuses the
  // SAME resolver boot/doctor/`config show` apply (`resolveEffectiveEmbeddings`, itself built on
  // `probeEmbeddingsProviderSource`) rather than a fourth copy of that fallback logic.
  // `source: "derived"` is the honest attribution — this comes from reading cache.db, not from the
  // file, env, profile, or a plain schema default. `raw` is already known-valid here (explainConfig
  // above did not throw), and cloned so this second `finalizeConfig` call cannot retroactively
  // mutate the object `explainConfig` was given.
  const resolvedForEmbeddings = finalizeConfig(structuredClone(raw));
  const embeddingsEffective = await resolveEffectiveEmbeddings(
    resolvedForEmbeddings.cacheDir,
    resolvedForEmbeddings.db.busyTimeoutMs,
    {
      providerExplicit: isEmbeddingsProviderExplicit(raw),
      onProviderChange: resolvedForEmbeddings.embeddings.onProviderChange,
      configured: {
        provider: resolvedForEmbeddings.embeddings.provider,
        model: resolvedForEmbeddings.embeddings.model,
        dimensions: resolvedForEmbeddings.embeddings.dimensions,
      },
      vaultIds: resolvedForEmbeddings.vaults.map((v) => v.id),
    },
  );
  const effectiveDetail =
    embeddingsEffective.source === "kept-from-index"
      ? "kept-from-index — kept from this vault's existing index, not written in your config"
      : embeddingsEffective.source === "ambiguous-orphaned-index"
        ? "ambiguous-orphaned-index — could not confirm this vault's provider; see `obsidian-tc doctor`"
        : embeddingsEffective.source === "configured"
          ? "configured — matches embeddings.provider above"
          : "default — the schema default, no existing index to keep";
  const entries = [
    ...explained.entries,
    {
      path: "embeddings.effective",
      value: {
        provider: embeddingsEffective.provider,
        model: embeddingsEffective.model,
        dimensions: embeddingsEffective.dimensions,
      },
      source: "derived" as const,
      detail: effectiveDetail,
    },
  ].sort((a, b) => a.path.localeCompare(b.path));
  const counts = { ...explained.counts, derived: explained.counts.derived + 1 };

  const rows = cmd.source ? entries.filter((x) => x.source === cmd.source) : entries;
  if (cmd.json) {
    process.stdout.write(`${JSON.stringify({ entries: rows, counts }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`config: ${path}\n`);
  const c = counts;
  process.stdout.write(
    `sources: ${c.file} file, ${c.env} env, ${c.profile} profile, ${c.derived} derived, ${c.default} default\n\n`,
  );
  for (const r of rows) {
    const detail = r.detail ? `  (${r.detail})` : "";
    process.stdout.write(
      `  ${r.source.padEnd(8)} ${r.path} = ${JSON.stringify(r.value)}${detail}\n`,
    );
  }
}
