import { fileURLToPath } from "node:url";
import { USAGE } from "../args";
import { installPlugin } from "../plugin-install";
import type { Cmd } from "../shared";

export async function run_plugin_install(cmd: Cmd<"plugin-install">): Promise<void> {
  // NOTE (THE-466 slice 1): this literal is resolved against import.meta.url of whichever module
  // ends up executing it. `bun build`'s non-`--compile` output bundles every source module into one
  // dist/cli.js file, and at runtime import.meta.url there is dist/cli.js's OWN path (proven by
  // building and running `plugin install` against the bundled output) — not this file's pre-bundle
  // source path. So the literal must stay "./plugin/" (matching dist/cli.js -> dist/plugin/)
  // regardless of which src/ file this code lives in; rewriting it to a source-relative path (e.g.
  // "../../plugin/") would resolve OUTSIDE dist/ once bundled and break `plugin install` in the
  // published package. Unbundled dev/test runs (`bun src/cli.ts ...`) already fail to find a
  // src/plugin/ directory before and after this move (it only exists as dist/plugin/, vendored at
  // build time by scripts/copy-assets.mjs) — same handled "not vendored" error either way.
  const pluginSrcDir = fileURLToPath(new URL("./plugin/", import.meta.url));
  try {
    const r = installPlugin(cmd.vaultPath, pluginSrcDir);
    process.stdout.write(
      `installed ${r.pluginName} v${r.pluginVersion} -> ${r.dest}\n` +
        `Enable it in Obsidian: Settings -> Community plugins -> ${r.pluginId}.\n`,
    );
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`);
    process.exit(2);
  }
  return;
}
