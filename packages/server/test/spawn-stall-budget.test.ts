// Source-scan gate: a test must size its budgets against a stalled Windows runner
// (stall-timeouts.ts), not against the work. windows-latest stalls the whole runner for 10-60s at
// a time; whatever is in flight is stretched by the stall, so a tight `spawnSync` kill timeout,
// readiness timer or per-test timeout turns a stall into a failure.
//
// Incidents. `memory-import-cli` "exits 2 when --from/--dir/--vault are missing" ran 20031ms and
// got exit -1 (killed by its own `timeout: SPAWN_TIMEOUT_MS`, 20_000) instead of 2 on
// windows-latest (run 36794595067). The first version of this gate was a line regex; within the
// hour `setup-first-run-fallback-e2e` "two REAL concurrent processes racing the same first-run
// converge on ONE file" timed out at 20000ms on windows-latest (run 36802115851), because its
// per-test timeout sits on its OWN line after the callback (`    },\n    20_000,\n  );`), a layout
// the `}, N)` regex could not see. A layout-sensitive regex misses whatever shape the next author
// formats, so the scan is now structural: ast-grep (the repo's pinned parser, scripts/ast-grep-bin.mjs)
// finds the budget by its role in the syntax tree, whatever the line breaks, separators or wrapping.
//
// The gate first covered only files that spawn, and the class kept flaking in files that do not:
// `plane-disabled-reflect-stays-wired` "reflect runs a real synthesis pass ... plane.enabled: false"
// failed `Test timed out in 15000ms` twice on windows-latest (merge-queue jobs 110354449845 and
// 110622432589) because its explicit `}, 15000)` overrides the Windows floor in vitest.config.ts. An
// explicit per-test timeout REPLACES the floor, so it is a budget wherever it appears.
//
// In EVERY test file, no literal budget below the Windows ceiling in a vitest role:
//   - a number (or constant expression, or a const that resolves to one) passed to
//     it/test/describe/beforeAll/afterAll/beforeEach/afterEach, in any argument position;
//   - a `timeout` / `testTimeout` / `hookTimeout` property, covering options-first
//     `it(name, { timeout }, fn)`, `vi.waitFor({ timeout })` and `vi.setConfig({ testTimeout })`.
// In a file that spawns (imports `node:child_process`, calls Bun.spawn, or imports a test helper
// that does), also in the child-process roles:
//   - a `timeout` property on spawn/spawnSync/execFile (above), a `setTimeout` kill/reject timer,
//     `AbortSignal.timeout`, or a `Date.now() + N` deadline;
//   - a `*TIMEOUT*`/`*BOUND*`/`*BUDGET*`/`*DEADLINE*` numeric constant.
// Wrap it: `stallTimeout(N)`. A value that is not a stall budget (a SQLite busy_timeout argument, a
// `timeout: 2` outcome count in a fixture row) carries a `stall-ok:` comment on its line saying so.
// The default for a test or hook with no explicit timeout is vitest.config.ts's Windows floor
// (`testTimeout` AND `hookTimeout`), pinned to the same constant below.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { astGrep } from "../../../scripts/ast-grep-bin.mjs";
import { stallTimeout, WINDOWS_STALL_TIMEOUT_MS } from "./stall-timeouts";
import { makeTempDir, rmTemp } from "./tmp";

type UserConfigTest = { testTimeout: number; hookTimeout: number };
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SELF = resolve(fileURLToPath(import.meta.url));
const SCAN_BUDGET = { timeout: stallTimeout(30_000) };

// One ast-grep invocation runs every rule below over a directory. `$V` is the budget expression,
// `$FN` the callee; a rule without a metavariable reports the matched node itself.
const EXPR_KINDS = `any:
  - kind: number
  - kind: identifier
  - kind: binary_expression
  - kind: parenthesized_expression
  - kind: unary_expression`;
const RULES = String.raw`id: test-call-arg
language: ts
rule:
  ${EXPR_KINDS.replaceAll("\n", "\n  ")}
  inside:
    kind: arguments
    inside:
      pattern: $FN($$$)
constraints:
  FN:
    regex: '^(it|test|describe|beforeAll|afterAll|beforeEach|afterEach)\b'
---
id: timeout-pair
language: ts
rule:
  ${EXPR_KINDS.replaceAll("\n", "\n  ")}
  inside:
    kind: pair
    field: value
    has:
      field: key
      regex: '^["'']?(timeout|testTimeout|hookTimeout)["'']?$'
---
id: timeout-shorthand
language: ts
rule:
  kind: shorthand_property_identifier
  regex: '^(timeout|testTimeout|hookTimeout)$'
---
id: kill-timer
language: ts
rule:
  pattern: setTimeout($CB, $V)
constraints:
  CB:
    regex: '\b(reject|kill)\b'
  V:
    ${EXPR_KINDS.replaceAll("\n", "\n    ")}
---
id: abort-timeout
language: ts
rule:
  pattern: AbortSignal.timeout($V)
---
id: deadline
language: ts
rule:
  pattern: Date.now() + $V
constraints:
  V:
    ${EXPR_KINDS.replaceAll("\n", "\n    ")}
---
id: const-value
language: ts
rule:
  kind: variable_declarator
  has:
    field: value
    ${EXPR_KINDS.replaceAll("\n", "\n    ")}
---
id: import-stmt
language: ts
rule:
  kind: import_statement
  not:
    regex: '^import\s+type\b'
---
id: import-call
language: ts
rule:
  pattern: import($V)
constraints:
  V:
    kind: string
---
id: require-call
language: ts
rule:
  pattern: require($V)
constraints:
  V:
    kind: string
---
id: bun-spawn
language: ts
rule:
  pattern: Bun.$M($$$)
constraints:
  M:
    regex: '^spawn(Sync)?$'
`;

interface Hit {
  rule: string;
  file: string;
  line: number;
  text: string;
}

function scanDir(dir: string): Hit[] {
  const bin = astGrep();
  const out = execFileSync(
    bin.cmd,
    [...bin.prefix, "scan", "--inline-rules", RULES, "--json=compact", dir],
    {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      ...SCAN_BUDGET,
    },
  );
  if (!out.trim()) return [];
  const raw = JSON.parse(out) as Array<{
    ruleId: string;
    file: string;
    text: string;
    range: { start: { line: number } };
    metaVariables?: {
      single?: Record<string, { text: string; range: { start: { line: number } } }>;
    };
  }>;
  return raw.map((m) => {
    const v = m.metaVariables?.single?.V;
    return {
      rule: m.ruleId,
      file: resolve(m.file),
      text: v?.text ?? m.text,
      line: (v ?? m).range.start.line + 1,
    };
  });
}

// Constant-folds a budget expression: numeric literals (`_` separators, hex, exponent), consts of
// the same file, `+ - * /` and parentheses. Anything else (a `stallTimeout(...)` call, a property
// read) is not a literal budget, so it is undefined and never flagged.
function budgetValue(
  expr: string,
  consts: ReadonlyMap<string, string>,
  seen: ReadonlySet<string> = new Set(),
): number | undefined {
  const toks = expr.match(/0x[\da-f_]+|\d[\d_]*(?:\.[\d_]+)?(?:e[+-]?\d+)?|[A-Za-z_$][\w$]*|\S/gi);
  if (!toks) return undefined;
  let i = 0;
  const primary = (): number | undefined => {
    const t = toks[i++];
    if (t === undefined) return undefined;
    if (t === "(") {
      const v = sum();
      return toks[i++] === ")" ? v : undefined;
    }
    if (t === "-") {
      const v = primary();
      return v === undefined ? undefined : -v;
    }
    if (/^[\d]/.test(t)) return Number(t.replaceAll("_", ""));
    const bound = consts.get(t);
    if (bound === undefined || seen.has(t)) return undefined;
    return budgetValue(bound, consts, new Set([...seen, t]));
  };
  const product = (): number | undefined => {
    let v = primary();
    while (v !== undefined && (toks[i] === "*" || toks[i] === "/")) {
      const op = toks[i++];
      const r = primary();
      v = r === undefined ? undefined : op === "*" ? v * r : v / r;
    }
    return v;
  };
  const sum = (): number | undefined => {
    let v = product();
    while (v !== undefined && (toks[i] === "+" || toks[i] === "-")) {
      const op = toks[i++];
      const r = product();
      v = r === undefined ? undefined : op === "+" ? v + r : v - r;
    }
    return v;
  };
  const v = sum();
  return i === toks.length ? v : undefined;
}

const CHILD_PROCESS = /^(?:node:)?child_process$/;
const importedSpecs = (h: Hit): string[] => {
  const m = /\bfrom\s*["']([^"']+)["']|^import\s*["']([^"']+)["']/.exec(h.text);
  const spec = h.rule === "import-stmt" ? (m?.[1] ?? m?.[2]) : h.text.slice(1, -1);
  return spec === undefined ? [] : [spec];
};
const moduleKey = (path: string) => path.replace(/\.(?:[cm]?[jt]s)$/, "");

// Files that spawn: import (or require, or dynamically import) node:child_process, call
// Bun.spawn, or import a non-test helper module that does (transitively), so a wrapper such as
// spawn-cli.ts puts its importers in scope without a hand-kept helper list.
function spawningFiles(hits: Hit[]): Set<string> {
  const specsByFile = new Map<string, string[]>();
  const spawning = new Set<string>();
  for (const h of hits) {
    if (h.rule === "bun-spawn") spawning.add(h.file);
    if (h.rule !== "import-stmt" && h.rule !== "import-call" && h.rule !== "require-call") continue;
    const specs = importedSpecs(h);
    specsByFile.set(h.file, [...(specsByFile.get(h.file) ?? []), ...specs]);
    if (specs.some((s) => CHILD_PROCESS.test(s))) spawning.add(h.file);
  }
  for (let grew = true; grew; ) {
    grew = false;
    const helpers = new Set([...spawning].filter((f) => !f.endsWith(".test.ts")).map(moduleKey));
    for (const [file, specs] of specsByFile) {
      if (spawning.has(file)) continue;
      const viaHelper = specs.some(
        (s) => s.startsWith(".") && helpers.has(moduleKey(resolve(dirname(file), s))),
      );
      if (viaHelper) {
        spawning.add(file);
        grew = true;
      }
    }
  }
  return spawning;
}

const LABELS: Record<string, string> = {
  "test-call-arg": "test/hook timeout argument",
  "timeout-pair": "`timeout` property",
  "timeout-shorthand": "`timeout` shorthand property",
  "kill-timer": "kill/reject timer",
  "abort-timeout": "`AbortSignal.timeout`",
  deadline: "`Date.now() +` deadline",
  "const-value": "budget constant",
};
const BUDGET_NAME = /(TIMEOUT|BOUND|BUDGET|DEADLINE)/;
const lowBudget = (n: number | undefined): n is number =>
  n !== undefined && n < WINDOWS_STALL_TIMEOUT_MS;

// The roles that size a vitest budget (a test/hook argument, a `timeout` property, a
// `vi.setConfig`). They are checked in EVERY test file: the Windows floor in vitest.config.ts is
// only a default, so an explicit per-test or per-describe literal below the ceiling silently
// overrides it. The remaining roles (kill timers, deadlines, budget constants) size a child
// process, so they stay scoped to the files that spawn one.
const VITEST_ROLES: ReadonlySet<string> = new Set([
  "test-call-arg",
  "timeout-pair",
  "timeout-shorthand",
]);

// `file:line: label `source` (= N)` for every literal budget under the Windows ceiling: a vitest
// budget in any file, a child-process budget in a file that spawns. `(= N)` appears when the
// source text is not itself the number.
function stallBudgetViolations(hits: Hit[]): string[] {
  const out: string[] = [];
  const spawners = spawningFiles(hits);
  const byFile = new Map<string, Hit[]>();
  for (const h of hits) byFile.set(h.file, [...(byFile.get(h.file) ?? []), h]);
  for (const [file, fileHits] of byFile) {
    if (file === SELF) continue;
    const spawns = spawners.has(file);
    const mine = fileHits.sort((a, b) => a.line - b.line);
    const lines = readFileSync(file, "utf8").split("\n");
    const consts = new Map<string, string>();
    for (const h of mine) {
      const m =
        h.rule === "const-value" ? /^(\w+)\s*(?::[^=]+?)?=\s*([\s\S]+)$/.exec(h.text) : null;
      if (m) consts.set(m[1] as string, m[2] as string);
    }
    for (const h of mine) {
      const label = LABELS[h.rule];
      if (label === undefined || lines[h.line - 1]?.includes("stall-ok:")) continue;
      if (!spawns && !VITEST_ROLES.has(h.rule)) continue;
      let source = h.text;
      let value: number | undefined;
      if (h.rule === "const-value") {
        const m = /^(\w+)\s*(?::[^=]+?)?=\s*([\s\S]+)$/.exec(h.text);
        const name = m?.[1] ?? "";
        if (!BUDGET_NAME.test(name) || /BUSY/.test(name)) continue;
        source = `const ${name} = ${m?.[2]}`;
        value = budgetValue(m?.[2] ?? "", consts);
      } else {
        value = budgetValue(h.text, consts);
      }
      if (!lowBudget(value)) continue;
      const resolved = h.rule === "const-value" || /^[\d_]+$/.test(source) ? "" : ` (= ${value})`;
      out.push(
        `${basename(file)}:${h.line}: ${label} \`${source.replace(/\s+/g, " ")}\`${resolved}`,
      );
    }
  }
  return out;
}

const CP = 'import { spawn, spawnSync } from "node:child_process";\n';
// Verbatim shapes from the incidents, then the shapes the line regex could not see.
const RED: Record<string, string> = {
  // memory-import-cli.test.ts as it was when run 36794595067 was killed at 20031ms
  "memory-import-cli.ts": `${CP}const SPAWN_TIMEOUT_MS = 20_000;
function runCli(args: string[]): Run {
  const r = spawnSync("bun", [CLI, ...args], {
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
    env: { ...process.env, NO_COLOR: "1" },
  });
}`,
  // setup-first-run-fallback-e2e.test.ts as it was when run 36802115851 (job 110178526157) timed
  // out at 20000ms: the vitest timeout is the trailing argument on its OWN line
  "setup-first-run-fallback-e2e.ts": `${CP}describe("x", () => {
  it.runIf(bunAvailable)(
    "two REAL concurrent processes racing the same first-run converge on ONE file",
    async () => {
      const { vaultPaths } = fakeObsidianEnv(["main"]);

      const runProbe = (): Promise<{ code: number | null; stdout: string; stderr: string }> =>
        new Promise((resolve) => {
          const child = spawn("bun", [PROBE], { env: process.env, stdio: "pipe" });
          child.on("close", (code) => resolve({ code, stdout, stderr }));
        });
      expect(onDisk.vaults).toMatchObject([{ id: "main", path: vaultPaths.main }]);
    },
    20_000,
  );
});`,
  // auth-registry-lost.test.ts / memory-import-safety.test.ts
  "literal-timeout.ts": `${CP}spawnSync("bun", [CLI], {\n      timeout: 20_000,\n});`,
  // vault-lock.test.ts / session-rerun-sandbox-e2e.test.ts per-test timeouts
  "per-test.ts": `${CP}it("a", () => {\n  }, 10_000);\nit("b", () => {\n  }, 30_000);`,
  // vault-lock.test.ts holder readiness timer + vault-leader-failover.test.ts promotion deadline
  "ready-and-deadline.ts": `${CP}const timer = setTimeout(
  () => reject(new Error(\`holder probe never reported LEADER: \${out}\`)),
  15_000,
);
const deadline = Date.now() + 20_000;`,
  "layouts.ts": `${CP}const T = 7000;
const MS = 1_000;
describe.skipIf(win)("a", () => {}, 5000);
describe("b", { timeout: 10_000 }, () => {});
it(
  "c",
  { timeout: 20 * MS },
  () => {},
);
it("d", () => {}, T);
it.each([1, 2])("e", () => {}, (30 * 1000));
beforeAll(() => {}, 15_000);
afterEach(
  () => {},
  1e4,
);
vi.setConfig({ testTimeout: 5000 });
vi.setConfig({
  hookTimeout: 0x2710,
});
const opts = { "timeout": 9_000 };
function f(timeout: number) { return spawnSync("bun", { timeout }); }
const timeout = 4000;
spawnSync("bun", { timeout });
const t = setTimeout(() => child.kill("SIGKILL"), 12_000);
const t2 = setTimeout(reject, 8 * MS);
const sig = AbortSignal.timeout(30_000);
const lo = Date.now() + (5 * 1000);
const OVERALL_BUDGET: number = 50_000;
const BUSY_TIMEOUT = 5000;`,
  // plane-disabled-reflect-stays-wired.test.ts as it was when merge-queue jobs 110354449845 and
  // 110622432589 hit `Test timed out in 15000ms`. NO child process: the guard must still flag it.
  "plane-disabled-reflect-stays-wired.ts": `import { describe, expect, it } from "vitest";
describe("plane disabled + gateway configured -> reflect stays available", () => {
  it("reflect runs a real synthesis pass (available: true, live gateway) with plane.enabled: false", async () => {
    globalThis.fetch = stubChatFetch();
    try {
      expect(out.available).toBe(true);
    } finally {
      await runtime.close("test cleanup");
    }
    // this asserts a wiring invariant (reflect stays available when plane.enabled=false),
    // not a latency budget — the default 5s flakes only on windows-latest
  }, 15000);
});`,
  // non-spawning files: every vitest role is in scope, the child-process roles are not
  "vitest-roles-no-spawn.ts": `it("a", () => {}, 12_000);
it("b", { timeout: 9_000 }, () => {});
describe("c", { timeout: 30_000 }, () => {});
beforeAll(async () => {}, 20_000);
vi.setConfig({ hookTimeout: 10_000 });
await vi.waitFor(() => {}, { timeout: 5000, interval: 20 });`,
  // Bun.spawn / require(...) / helper-import spawners are in scope too
  "bun-spawn.ts": `const p = Bun.spawn(["bun", "x"]);\nit("a", async () => {\n}, 2_000);`,
  "require-spawn.ts": `const { spawn } = require("child_process");\nit("a", () => {}, 2_000);`,
  "dynamic-import.ts": `const cp = await import("node:child_process");\nit("a", () => {}, 2_000);`,
  "via-helper.test.ts": `import { runIt } from "./helper-spawner";\nit("a", () => runIt(), 2_000);`,
  "helper-spawner.ts": `import { spawnSync } from "node:child_process";\nexport const runIt = () => spawnSync("bun");`,
  "via-helper-chain.test.ts": `import { runIt } from "./helper-chain";\nit("a", () => runIt(), 2_000);`,
  "helper-chain.ts": `export { runIt } from "./helper-spawner";\nimport { runIt } from "./helper-spawner";\nexport const r = runIt;`,
};
const GREEN: Record<string, string> = {
  "wired.ts": `${CP}import { stallTimeout } from "./stall-timeouts";
const SPAWN_TIMEOUT_MS = stallTimeout(20_000);
spawnSync("bun", [CLI], { timeout: stallTimeout(20_000) });
it("a", () => {}, stallTimeout(30_000));
it("b", { timeout: stallTimeout(10_000) }, () => {});
it(
  "c",
  async () => {},
  120_000,
);
it("d", () => {}, ${WINDOWS_STALL_TIMEOUT_MS});
vi.setConfig({ testTimeout: stallTimeout(5000) });
const T = setTimeout(() => child.kill(), stallTimeout(9_000));
const sleepy = setTimeout(done, 50);
run({ timeoutMs: 5000 });
const deadline = Date.now() + stallTimeout(20_000);
const BUSY_TIMEOUT_MS = 5000;
it("e", () => {}, 5000); // stall-ok: busy_timeout argument, not a test budget
const SMALL = 5;
expect(x).toBe(5000);`,
  "type-only.ts":
    'import type { spawn } from "node:child_process";\nit("a", () => {}, stallTimeout(5000));',
  "non-spawn.ts": `import { stallTimeout } from "./stall-timeouts";
it("a", () => {}, stallTimeout(5000));
it("b", { timeout: stallTimeout(9_000) }, () => {});
beforeAll(async () => {}, 60_000);
await vi.waitFor(() => {}, { timeout: stallTimeout(5000), interval: 20 });
// the child-process roles are only in scope where a child is spawned
const t = setTimeout(reject, 5000);
const sig = AbortSignal.timeout(5000);
const deadline = Date.now() + 5000;
const OVERALL_BUDGET = 5000;`,
  "helper-not-spawner.test.ts": `import { notASpawner } from "./not-a-spawner";\nit("a", () => {}, stallTimeout(5000));`,
  "not-a-spawner.ts": "export const notASpawner = 1;",
};

describe("tests are budgeted against a stalled Windows runner", () => {
  let fixtureDir = "";
  let fixtureViolations: string[] = [];
  let treeHits: Hit[] = [];

  beforeAll(() => {
    fixtureDir = makeTempDir("spawn-stall-guard-");
    mkdirSync(join(fixtureDir, "red"));
    mkdirSync(join(fixtureDir, "green"));
    for (const [name, src] of Object.entries(RED))
      writeFileSync(join(fixtureDir, "red", name), src);
    for (const [name, src] of Object.entries(GREEN))
      writeFileSync(join(fixtureDir, "green", name), src);
    fixtureViolations = stallBudgetViolations(scanDir(fixtureDir));
    treeHits = scanDir(TEST_DIR);
  }, stallTimeout(30_000));
  afterAll(() => {
    if (fixtureDir) rmTemp(fixtureDir);
  });

  const forFile = (name: string) => fixtureViolations.filter((v) => v.startsWith(`${name}:`));

  it("flags the incident shapes (RED cases, verbatim from the flaking files)", () => {
    expect(forFile("memory-import-cli.ts")).toEqual(
      expect.arrayContaining([
        expect.stringContaining("budget constant `const SPAWN_TIMEOUT_MS = 20_000`"),
        expect.stringContaining("`timeout` property `SPAWN_TIMEOUT_MS` (= 20000)"),
      ]),
    );
    // the per-test timeout on its own line, after the callback (run 36802115851)
    expect(forFile("setup-first-run-fallback-e2e.ts")).toEqual([
      expect.stringContaining("test/hook timeout argument `20_000`"),
    ]);
    expect(forFile("literal-timeout.ts")).toEqual([
      expect.stringContaining("`timeout` property `20_000`"),
    ]);
    expect(forFile("per-test.ts")).toEqual([
      expect.stringContaining("test/hook timeout argument `10_000`"),
      expect.stringContaining("test/hook timeout argument `30_000`"),
    ]);
    expect(forFile("ready-and-deadline.ts")).toEqual([
      expect.stringContaining("kill/reject timer `15_000`"),
      expect.stringContaining("`Date.now() +` deadline `20_000`"),
    ]);
  });

  it("flags the incident shape in a file that spawns nothing (plane-disabled-reflect, 15000)", () => {
    expect(forFile("plane-disabled-reflect-stays-wired.ts")).toEqual([
      expect.stringContaining("test/hook timeout argument `15000`"),
    ]);
    expect(forFile("vitest-roles-no-spawn.ts")).toEqual([
      expect.stringContaining("test/hook timeout argument `12_000`"),
      expect.stringContaining("`timeout` property `9_000`"),
      expect.stringContaining("`timeout` property `30_000`"),
      expect.stringContaining("test/hook timeout argument `20_000`"),
      expect.stringContaining("`timeout` property `10_000`"),
      expect.stringContaining("`timeout` property `5000`"),
    ]);
  });

  it("flags every layout and role, not just the one-line `}, N)` shape", () => {
    const layouts = forFile("layouts.ts").join("\n");
    for (const fragment of [
      "test/hook timeout argument `5000`", // describe.skipIf(win)(..., 5000)
      "`timeout` property `10_000`", // describe options-first
      "`timeout` property `20 * MS` (= 20000)", // options-first on its own lines
      "test/hook timeout argument `T` (= 7000)", // const resolved at the call
      "test/hook timeout argument `(30 * 1000)` (= 30000)", // it.each(...)(..., expr)
      "test/hook timeout argument `15_000`", // beforeAll
      "test/hook timeout argument `1e4` (= 10000)", // afterEach, trailing comma on its own line
      "`timeout` property `5000`", // vi.setConfig testTimeout
      "`timeout` property `0x2710` (= 10000)", // vi.setConfig hookTimeout, hex
      "`timeout` property `9_000`", // quoted key
      "`timeout` shorthand property `timeout`",
      "kill/reject timer `12_000`",
      "kill/reject timer `8 * MS` (= 8000)",
      "`AbortSignal.timeout` `30_000`",
      "`Date.now() +` deadline `(5 * 1000)` (= 5000)",
      "budget constant `const OVERALL_BUDGET = 50_000`",
    ]) {
      expect(layouts, fragment).toContain(fragment);
    }
    // a BUSY_TIMEOUT constant is a SQLite argument, not a stall budget
    expect(layouts).not.toContain("BUSY_TIMEOUT");
  });

  it("counts Bun.spawn, require() and dynamic-import spawners and their helper importers", () => {
    for (const f of [
      "bun-spawn.ts",
      "require-spawn.ts",
      "dynamic-import.ts",
      "via-helper.test.ts",
      "via-helper-chain.test.ts",
    ]) {
      expect(forFile(f), f).toEqual([expect.stringContaining("`2_000`")]);
    }
  });

  it("accepts stallTimeout-wrapped budgets, ones at the ceiling, stall-ok lines and non-spawn files", () => {
    const green = fixtureViolations.filter((v) =>
      /^(wired|type-only|non-spawn|helper-not)/.test(v),
    );
    expect(green).toEqual([]);
  });

  it("holds for every test file, spawning or not (existence floor: the scan finds them)", () => {
    const files = new Set(
      treeHits
        .filter((h) => h.file !== SELF && !h.file.includes(`${sep}fixtures${sep}`))
        .map((h) => h.file),
    );
    expect(files.size).toBeGreaterThanOrEqual(500);
    const inScope = treeHits.filter((h) => files.has(h.file));
    const spawners = spawningFiles(treeHits);
    // the scan sees the vitest roles at all, in spawning and in non-spawning files: a parser that
    // matched no timeout would pass vacuously
    expect(inScope.filter((h) => h.rule === "timeout-pair").length).toBeGreaterThanOrEqual(3);
    expect(inScope.filter((h) => h.rule === "test-call-arg").length).toBeGreaterThanOrEqual(100);
    const nonSpawn = inScope.filter((h) => !spawners.has(h.file));
    expect(nonSpawn.filter((h) => h.rule === "test-call-arg").length).toBeGreaterThanOrEqual(50);
    // spawn files keep the child-process roles on top
    const spawnFiles = [...spawners].filter((f) => files.has(f));
    expect(spawnFiles.length).toBeGreaterThanOrEqual(30);
    expect(stallBudgetViolations(inScope)).toEqual([]);
  });

  it("vitest.config.ts floors the Windows per-test AND hook timeouts at the same shared ceiling", async () => {
    const cfg = readFileSync(join(TEST_DIR, "..", "vitest.config.ts"), "utf8");
    expect(cfg).toContain('from "./test/stall-timeouts"');
    const platform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
    // `vitest/config` pulls in vite -> rollup's native binding, which resolves per platform: load it
    // once under the real one so the stubbed loads below only evaluate vitest.config.ts itself.
    await import("vitest/config");
    const load = async (os: string) => {
      Object.defineProperty(process, "platform", { ...platform, value: os });
      try {
        vi.resetModules();
        return ((await import("../vitest.config")) as { default: { test: UserConfigTest } }).default
          .test;
      } finally {
        Object.defineProperty(process, "platform", platform);
      }
    };
    // `hookTimeout` is vitest's own 10s on the other two OSes, which was never floored on Windows
    // (response-format-coverage `beforeAll`: "Hook timed out in 10000ms", job 110622432589)
    expect(await load("win32")).toMatchObject({
      testTimeout: WINDOWS_STALL_TIMEOUT_MS,
      hookTimeout: WINDOWS_STALL_TIMEOUT_MS,
    });
    for (const os of ["linux", "darwin"]) {
      expect(await load(os), os).toMatchObject({ testTimeout: 5_000, hookTimeout: 10_000 });
    }
  });
});
