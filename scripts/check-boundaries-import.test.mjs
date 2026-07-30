// Isolated from check-boundaries.test.mjs on purpose: this file must NOT statically import
// check-boundaries.mjs. If the entry-point guard in that module ever regresses (main() runs on
// import instead of only under `node scripts/check-boundaries.mjs`), a file that imported it
// statically would have main() run — and its process.exit() call — during its own module
// evaluation, before any test() in that file registers. node's test runner then reports that
// file as a trivial "1 passed" (a *.test.mjs with zero test() calls still prints "tests 1 / pass
// 1" — verified empirically), which would silently swallow the regression instead of failing.
//
// This file spawns the module in its OWN child process instead, so it keeps registering and
// running its own test regardless of what check-boundaries.mjs does on import.
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
