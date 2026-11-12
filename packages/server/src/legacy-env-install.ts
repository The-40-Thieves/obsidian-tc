// Side-effect module: cli.ts imports it FIRST, so its body runs before any other module reads
// configuration from the environment. It copies every OBSIDIAN_TC_* variable to its
// RELIQUARY_TC_* name (the new name wins when both are set) and warns once on stderr.
import {
  applyLegacyEnvAliases,
  CURRENT_NAMES,
  LEGACY_NAMES,
} from "@the-40-thieves/reliquary-tc-shared";

const aliased = applyLegacyEnvAliases(process.env);
if (aliased.length > 0) {
  process.stderr.write(
    `warning: ${aliased.join(", ")} ${aliased.length === 1 ? "uses" : "use"} the old ${LEGACY_NAMES.envPrefix} prefix. ` +
      `It still works through 2.x; rename to ${CURRENT_NAMES.envPrefix}.\n`,
  );
}
