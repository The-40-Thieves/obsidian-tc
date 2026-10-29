// A separate process keeps an accidental process.exit() during import observable to the test.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("importing check-boundaries.mjs runs no operational code (main() only fires under the entry-point guard)", () => {
  const moduleUrl = new URL("./check-boundaries.mjs", import.meta.url).href;
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
  // If main() ran on import, its own console.log("boundary gate: ...") lines would be in stdout
  // whether or not the process went on to exit 0 — that is the discriminator, not the exit code.
  assert.match(result.stdout, /IMPORT_OK/);
  assert.doesNotMatch(result.stdout, /boundary gate:/);
});
