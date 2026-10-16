// Pin `os.homedir()` to a throwaway directory for every test file, before any of it runs.
//
// The class this closes: several src paths anchor on `homedir()` — `defaultSetupConfigPath()`
// (`~/.obsidian-tc/config.json`, `resolveServeConfigWithProvenance`'s last-resort fallback and
// `obsidian-tc setup`'s write target), the `cacheDir` schema default, capability discovery, the
// first-run fallback. A test that reached any of them without stubbing HOME read (or wrote) the
// developer's REAL home: on a machine with a `~/.obsidian-tc/config.json`, "no OBSIDIAN_TC_CONFIG
// and no argument -> 'no vault or config given'" loaded that file instead and failed, while CI
// (a clean runner home) stayed green. Pinning it once here, as a vitest `setupFiles` entry, covers
// every test file — present and future — instead of a per-test stub each author has to remember.
// A test that needs its OWN home still calls `stubHomedir` (tmp.ts); its restore now returns to
// this pinned directory, never the real one.
// The per-file home also gave every Bun child a cold runtime transpiler cache, forcing each test
// file to repopulate the same import graph. Concurrent cache writes stalled Windows runners until
// the 60-second subprocess guard fired, so Bun children share one repo-local cache across the run.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";
import { makeTempDir, stubHomedir } from "./tmp";

if (process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH === undefined) {
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const cachePath = join(repoRoot, "node_modules", ".cache", "obsidian-tc-bun-transpiler");
  mkdirSync(cachePath, { recursive: true });
  process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH = cachePath;
}

// `makeTempDir` under the realpath'd tmpdir (tmpdir-realpath-setup.ts runs first), so the pinned
// home is never under a symlinked ancestor either. It is removed by makeTempDir's own file-end,
// signal and exit sweeps; tmp-guard.ts allowlists it because a file whose tests are all skipped
// never runs afterAll and its worker's kill can race the gate's scan.
const home = makeTempDir("otc-test-home-");
const restore = stubHomedir(home);

afterAll(restore);
