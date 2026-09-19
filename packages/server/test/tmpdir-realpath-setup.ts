// THE-1081 / #946: canonicalize TMPDIR (TMP/TEMP on Windows) through realpath before any test
// runs. `os.tmpdir()` reads these env vars live, and macOS's default value sits under `/var` ->
// `/private/var` — a symlinked ancestor. 104 test files build fixture vaults via
// `mkdtempSync(join(tmpdir(), ...))`; canonicalizing the vault root at registration
// (vault/registry.ts) is too late for those, since `mkdtempSync` already returns a path under the
// symlinked prefix before any vault code sees it. Resolving the env var itself, once, up front,
// means `tmpdir()` never hands out a symlinked-ancestor path to begin with — a vitest `setupFiles`
// entry rather than a per-test change, so none of the 104 files need editing.
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

const real = realpathSync(tmpdir());
process.env.TMPDIR = real;
if (process.platform === "win32") {
  process.env.TMP = real;
  process.env.TEMP = real;
}
