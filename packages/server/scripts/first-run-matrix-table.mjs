// Folds the per-cell reports ci-first-run-smoke.yml uploads into the 3x3 markdown table on the run's
// step summary.   node first-run-matrix-table.mjs <reports-dir> <paths,..> <oses,..>
// Env: EXPECTED_FAILURES (the workflow's list). Reads <reports-dir>/first-run-<path>-<os>/report.json.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseExpectedFailures, renderMatrix } from "./lib/first-run-smoke-lib.mjs";

const [dir, pathsArg, osesArg] = process.argv.slice(2);
if (!dir || !pathsArg || !osesArg) {
  console.error("usage: first-run-matrix-table.mjs <reports-dir> <paths,..> <oses,..>");
  process.exit(2);
}
const paths = pathsArg.split(",");
const oses = osesArg.split(",");
const reports = new Map();
for (const path of paths) {
  for (const os of oses) {
    const file = join(dir, `first-run-${path}-${os}`, "report.json");
    if (existsSync(file)) reports.set(`${path}/${os}`, JSON.parse(readFileSync(file, "utf8")));
  }
}
const expected = parseExpectedFailures(process.env.EXPECTED_FAILURES ?? "");
console.log(renderMatrix({ paths, oses, reports, expected }));
