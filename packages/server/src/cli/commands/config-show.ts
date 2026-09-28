import { redactConfig } from "../args";
import { type Cmd, resolveOrUsageExitWithProvenance } from "../shared";
import { resolveEffectiveEmbeddings } from "./doctor-probes";

export async function run_config_show(cmd: Cmd<"config-show" | "config-validate">): Promise<void> {
  const { config, embeddingsProviderExplicit } = resolveOrUsageExitWithProvenance(cmd.configPath);
  if (cmd.kind === "config-validate") {
    process.stdout.write("config valid\n");
    return;
  }
  // GH #995 fix round 2 (finding 5): `config show` used to dump the SCHEMA-resolved
  // `embeddings.provider` (e.g. "local") with no indication that a real boot would instead KEEP a
  // different, existing index's provider — and re-saving that dump made "local" explicit,
  // disabling sticky resolution on the next boot. Reuses the SAME resolver boot/doctor apply
  // (`probeEmbeddingsProviderSource`, via `resolveEffectiveEmbeddings`) rather than reimplementing
  // it, and reports it as a SEPARATE `embeddingsEffective` annotation — `embeddings.provider`
  // above is left exactly as the schema resolved it, so a kept value can never be mistaken for
  // (or re-saved as) something the user actually configured.
  const effective = await resolveEffectiveEmbeddings(config.cacheDir, config.db.busyTimeoutMs, {
    providerExplicit: embeddingsProviderExplicit,
    onProviderChange: config.embeddings.onProviderChange,
    configured: {
      provider: config.embeddings.provider,
      model: config.embeddings.model,
      dimensions: config.embeddings.dimensions,
    },
    vaultIds: config.vaults.map((v) => v.id),
  });
  const note =
    effective.source === "configured"
      ? "matches embeddings.provider below — set explicitly in your config."
      : effective.source === "default"
        ? "the schema default — embeddings.provider is not set in your config."
        : effective.source === "kept-from-index"
          ? "KEPT from this vault's existing index — NOT part of your config. embeddings.provider " +
            "below is unset; do not copy this value into it unless you intend to PIN this provider " +
            "(that IS the opt-in to switch — see the embeddings docs' upgrade section)."
          : "AMBIGUOUS — no active vectors matched this vault's configured id, but this cache " +
            "directory holds active vectors under a DIFFERENT vault id (a rename, or a shared " +
            "cache dir). NOT part of your config. Run `obsidian-tc doctor` for details.";
  const out = {
    ...(redactConfig(config) as Record<string, unknown>),
    embeddingsEffective: {
      provider: effective.provider,
      model: effective.model,
      dimensions: effective.dimensions,
      source: effective.source,
      note,
    },
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}
