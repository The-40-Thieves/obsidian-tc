// Isolated from check-ingest-telemetry-wiring.test.mjs on purpose, mirroring
// check-boundaries-import.test.mjs's reasoning: that file already statically imports
// check-ingest-telemetry-wiring.mjs to reach its exported functions, so if the entry-point guard
// in that module ever regressed (main() running on import instead of only under `node
// scripts/check-ingest-telemetry-wiring.mjs`), main()'s process.exit() would kill the process
// during that file's own module evaluation, before any test() in it registers — and node's test
// runner reports a file that registered zero tests as a trivial "1 passed" rather than a failure.
// Only a file that never imports the module statically, and instead spawns it in its own child
// process, can actually observe that regression.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("importing check-ingest-telemetry-wiring.mjs runs no operational code (main() only fires under the entry-point guard)", () => {
  const moduleUrl = new URL("./check-ingest-telemetry-wiring.mjs", import.meta.url).href;
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import(${JSON.stringify(moduleUrl)}).then(() => console.log("IMPORT_OK"))`,
    ],
    { encoding: "utf8", cwd: repoRoot },
  );

  assert.equal(result.status, 0, `import crashed: ${result.stderr}`);
  // If main() ran on import it would either print its own "ingest-telemetry-wiring gate: ..."
  // line or hit the git-ls-files/empty-scan error path and exit non-zero — either is the
  // discriminator, not just the exit code.
  assert.match(result.stdout, /IMPORT_OK/);
  assert.doesNotMatch(result.stdout, /ingest-telemetry-wiring gate:/);
});
