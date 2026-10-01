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
import { afterAll } from "vitest";
import { makeTempDir, stubHomedir } from "./tmp";

// `makeTempDir` under the realpath'd tmpdir (tmpdir-realpath-setup.ts runs first), so the pinned
// home is never under a symlinked ancestor either. It is removed by makeTempDir's own file-end and
// process-exit sweeps, which (unlike an afterAll here) also run for a file whose tests are all
// skipped — live-companion.test.ts leaked one of these per run until it moved here.
const home = makeTempDir("otc-test-home-");
const restore = stubHomedir(home);

afterAll(restore);
