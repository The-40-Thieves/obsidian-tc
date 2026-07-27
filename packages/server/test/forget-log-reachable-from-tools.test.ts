// THE-600: `work_forget` (the MCP tool) used to tombstone an episode without ever touching
// `forget_log` — the THE-239 hash-chained audit trail. `appendForgetLog` had exactly 3 non-test
// call sites (its own definition plus `forget.ts:142`/`:307`, the CLI path) and ZERO under
// `src/tools/`. The tool's own description promised a forensics log row that never got written.
//
// This is a source scan rather than a behavioural test because the failure it guards is
// structural: `m8-experiential-tools.test.ts` already proves work_forget's audit row exists TODAY,
// but nothing stops a future refactor from re-forking the tool handler back onto a bare UPDATE
// that quietly drops the appendForgetLog call while every existing behavioural test still passes
// (the tombstone still flips, work_search still stops returning the row). Only counting the call
// site catches that regression. Same reasoning as THE-516's paginate() gate.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const TOOLS_DIR = join(SRC, "tools");

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) tsFiles(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("THE-600 forget_log is reachable from the tool surface", () => {
  it("at least one file under src/tools/ calls appendForgetLog", () => {
    const files = tsFiles(TOOLS_DIR);
    // Sanity floor: if the walk found nothing, the assertion below would pass vacuously.
    expect(files.length).toBeGreaterThan(20);

    const callers = files.filter((f) => /\bappendForgetLog\s*\(/.test(readFileSync(f, "utf8")));
    expect(
      callers.length,
      "no file under src/tools/ calls appendForgetLog — a forget-shaped tool that tombstones " +
        "without writing the THE-239 hash-chained audit row is exactly the THE-600 defect",
    ).toBeGreaterThan(0);
  });
});
