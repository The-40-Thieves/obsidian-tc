// Source-scan gate: a test that spawns a child process must size its budgets against a stalled
// Windows runner (stall-timeouts.ts), not against the work. windows-latest stalls the whole
// runner for 10-60s at a time; a child in flight is stretched by the stall, so a tight `spawnSync`
// kill timeout, readiness timer or per-test timeout turns a stall into a failure.
//
// Incident: `memory-import-cli` "exits 2 when --from/--dir/--vault are missing" ran 20031ms and
// got exit -1 (killed by its own `timeout: SPAWN_TIMEOUT_MS`, 20_000) instead of 2 on
// windows-latest (run 36794595067). The RED cases below are that code and its siblings verbatim.
//
// In a file that spawns (imports `node:child_process`, or a helper that wraps it), no literal
// budget below the Windows ceiling: `timeout: N`, a trailing `}, N)` per-test timeout, a
// `*TIMEOUT*`/`*BOUND*`/`*BUDGET*`/`*DEADLINE*` constant, a `Date.now() + N` deadline, or a
// `setTimeout(() => reject(...), N)` readiness timer. Wrap it: `stallTimeout(N)`. A value that is
// not a stall budget (a SQLite busy_timeout argument) carries a `stall-ok:` comment saying so.
// The per-test default for files without an explicit timeout is vitest.config.ts's Windows floor,
// pinned to the same constant below.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WINDOWS_STALL_TIMEOUT_MS } from "./stall-timeouts";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SELF = "spawn-stall-budget.test.ts";
const SPAWNS =
  /^import\s+(?!type\b)[^;]*from\s+"(?:node:child_process|\.\/(?:dangling-wal-fixture|reranker-local-stage|spawn-cli))"|import\(\s*"node:child_process"\s*\)/m;
const num = (s: string) => Number(s.replaceAll("_", ""));
const low = (n: string) => num(n) < WINDOWS_STALL_TIMEOUT_MS;

function stallBudgetViolations(source: string): string[] {
  if (!SPAWNS.test(source)) return [];
  const out: string[] = [];
  const lines = source
    .split("\n")
    .map((l) => (l.includes("stall-ok:") ? "" : l))
    .join("\n");
  const scan = (re: RegExp, label: (m: RegExpMatchArray) => string | undefined) => {
    for (const m of lines.matchAll(re)) {
      const msg = label(m);
      if (msg) out.push(msg);
    }
  };
  const consts = new Map<string, string>();
  scan(/\bconst\s+(\w+)\s*=\s*([\d_]+)\s*;/g, (m) => {
    consts.set(m[1] as string, m[2] as string);
    const named =
      /(TIMEOUT|BOUND|BUDGET|DEADLINE)/.test(m[1] as string) && !/BUSY/.test(m[1] as string);
    return named && low(m[2] as string) ? `\`const ${m[1]} = ${m[2]}\`` : undefined;
  });
  scan(/\btimeout:\s*([\d_]+)\b/g, (m) =>
    low(m[1] as string) ? `literal \`timeout: ${m[1]}\`` : undefined,
  );
  scan(/\btimeout:\s*([A-Z][A-Z0-9_]*)\b/g, (m) => {
    const v = consts.get(m[1] as string);
    return v !== undefined && low(v) ? `\`timeout: ${m[1]}\` (= ${v})` : undefined;
  });
  scan(/^\s*\}, (\d[\d_]{3,})\)/gm, (m) =>
    low(m[1] as string) ? `per-test timeout \`}, ${m[1]})\`` : undefined,
  );
  scan(/Date\.now\(\)\s*\+\s*([\d_]+)/g, (m) =>
    low(m[1] as string) ? `deadline \`Date.now() + ${m[1]}\`` : undefined,
  );
  scan(/setTimeout\(\s*\(\)\s*=>\s*reject\([\s\S]*?\),\s*([\d_]+),?\s*\)/g, (m) =>
    low(m[1] as string) ? `readiness timer \`${m[1]}\`` : undefined,
  );
  return out;
}

describe("spawn tests are budgeted against a stalled Windows runner", () => {
  it("flags the incident shapes (RED cases, verbatim from the flaking files)", () => {
    const imp = 'import { spawnSync } from "node:child_process";\n';
    // memory-import-cli.test.ts as it was when run 36794595067 was killed at 20031ms
    const memoryImportCli = `${imp}const SPAWN_TIMEOUT_MS = 20_000;
function runCli(args: string[]): Run {
  const r = spawnSync("bun", [CLI, ...args], {
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
    env: { ...process.env, NO_COLOR: "1" },
  });
}`;
    expect(stallBudgetViolations(memoryImportCli)).toEqual(
      expect.arrayContaining([
        "`const SPAWN_TIMEOUT_MS = 20_000`",
        "`timeout: SPAWN_TIMEOUT_MS` (= 20_000)",
      ]),
    );
    // auth-registry-lost.test.ts / memory-import-safety.test.ts
    expect(
      stallBudgetViolations(`${imp}spawnSync("bun", [CLI], {\n      timeout: 20_000,\n`),
    ).toContain("literal `timeout: 20_000`");
    // vault-lock.test.ts / session-rerun-sandbox-e2e.test.ts per-test timeouts
    expect(stallBudgetViolations(`${imp}  }, 10_000);\n  }, 30_000);\n`)).toEqual(
      expect.arrayContaining(["per-test timeout `}, 10_000)`", "per-test timeout `}, 30_000)`"]),
    );
    // vault-lock.test.ts holder readiness timer + vault-leader-failover.test.ts promotion deadline
    const ready = `${imp}const timer = setTimeout(
  () => reject(new Error(\`holder probe never reported LEADER: \${out}\`)),
  15_000,
);
const deadline = Date.now() + 20_000;`;
    expect(stallBudgetViolations(ready)).toEqual(
      expect.arrayContaining(["readiness timer `15_000`", "deadline `Date.now() + 20_000`"]),
    );
  });

  it("accepts stallTimeout-wrapped budgets, ones at the ceiling, stall-ok lines and non-spawn files", () => {
    const imp = 'import { spawnSync } from "node:child_process";\n';
    const wired = `${imp}import { stallTimeout } from "./stall-timeouts";
const SPAWN_TIMEOUT_MS = stallTimeout(20_000);
spawnSync("bun", [CLI], { timeout: stallTimeout(20_000) });
  }, stallTimeout(30_000));
  }, 120_000);
{ timeout: ${WINDOWS_STALL_TIMEOUT_MS} }
    }, 5000); // stall-ok: busy_timeout argument, not a test budget`;
    expect(stallBudgetViolations(wired)).toEqual([]);
    expect(
      stallBudgetViolations('import type { spawn } from "node:child_process";\n}, 5000)'),
    ).toEqual([]);
    expect(stallBudgetViolations("const x = 1;\n  }, 5000);\n")).toEqual([]);
  });

  it("holds for every test file that spawns (existence floor: the scan finds them)", () => {
    const files = readdirSync(TEST_DIR).filter((f) => f.endsWith(".ts") && f !== SELF);
    const spawners = files.filter((f) => SPAWNS.test(readFileSync(join(TEST_DIR, f), "utf8")));
    expect(spawners.length).toBeGreaterThanOrEqual(30);
    const bad = spawners.flatMap((f) =>
      stallBudgetViolations(readFileSync(join(TEST_DIR, f), "utf8")).map((v) => `${f}: ${v}`),
    );
    expect(bad).toEqual([]);
  });

  it("vitest.config.ts floors the Windows per-test timeout at the same shared ceiling", () => {
    const cfg = readFileSync(join(TEST_DIR, "..", "vitest.config.ts"), "utf8");
    expect(cfg).toMatch(/testTimeout:\s*process\.platform === "win32" \? WINDOWS_STALL_TIMEOUT_MS/);
    expect(cfg).toContain('from "./test/stall-timeouts"');
  });
});
