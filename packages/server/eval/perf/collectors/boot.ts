// THE-515 (family 16): cold-boot cost.
//
// WHY THIS FAMILY EXISTS. THE-515 proposed lazy-initializing embeddings, ColBERT, the native
// module, sqlite-vec, graph analytics, the Dataview bridge and the scheduler, on the premise that
// startup pays for them. Measured 2026-07-26, that premise did not hold: those subsystems cost
// ~13ms COMBINED, while module load/evaluation is ~83% of a ~290ms cold start. The refactor would
// have touched the boot path of six subsystems to recover single-digit milliseconds.
//
// Nothing in the harness could have told anyone that, because no metric described boot at all —
// `http.cold_ms` measures the per-request pipeline against an EMPTY registry, and `migration.ms`
// covers only schema setup. This family is the missing description, and it is the reason the next
// cold-start proposal can be argued from a number instead of an intuition.
//
// A FRESH SUBPROCESS IS MANDATORY, not a stylistic choice. By the time collectors run, the harness
// has already imported the tool surface, so an in-process timing would report warm-module-cache
// numbers and understate the one term that actually dominates. boot-probe.ts is that subprocess.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { BootProbeResult } from "../boot-probe";
import type { MetricSample } from "../report";

const BOOT_PROBE_PATH = fileURLToPath(new URL("../boot-probe.ts", import.meta.url));

/** Injectable so tests can exercise the parsing/guard logic without paying a real cold boot —
 *  the same seam sample.ts uses for its isolated runs. */
export type SpawnBootProbe = () => string;

function spawnBootProbe(): string {
  // stderr inherited: a probe failure should be readable in the job log, not swallowed.
  const result = spawnSync("bun", [BOOT_PROBE_PATH], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error) throw new Error(`boot probe failed to spawn: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`boot probe subprocess exited ${result.status}`);
  return result.stdout;
}

/** A finite number, rejecting the shapes `>` would silently coerce: numeric STRINGS ("600" passes
 *  `> 0`), null, NaN and Infinity. A metric that reached the report as a string would survive the
 *  gate's comparisons and corrupt an aggregate rather than fail. */
function num(v: unknown, field: string, { min }: { min: number }): number {
  if (typeof v !== "number" || !Number.isFinite(v))
    throw new Error(`boot probe: ${field} is not a finite number (got ${JSON.stringify(v)})`);
  if (v < min)
    throw new Error(`boot probe: ${field} is ${v}, below the minimum ${min} — the stage is wrong`);
  return v;
}

/** The probe prints exactly one JSON line; take the LAST non-empty line so a stray warning on
 *  stdout from a dependency cannot corrupt the parse. Every field is then validated rather than
 *  cast — the cast is a compile-time fiction over a subprocess's stdout. */
function parseProbe(stdout: string): BootProbeResult {
  const line = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .at(-1);
  if (!line) throw new Error("boot probe produced no output");
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new Error(`boot probe output was not JSON: ${line.slice(0, 200)}`);
  }
  if (typeof raw !== "object" || raw === null)
    throw new Error(`boot probe output was not an object: ${line.slice(0, 200)}`);
  const o = raw as Record<string, unknown>;
  const tools = num(o.tools_registered, "tools_registered", { min: 1 });
  if (!Number.isInteger(tools))
    throw new Error(`boot probe: tools_registered is not an integer (got ${tools})`);
  return {
    // Durations must be POSITIVE: a stage that measured 0ms did not run. tools_list_ms is the one
    // that may legitimately round to 0 on a fast host, so it takes min 0 — but it must still be a
    // real finite number, not absent.
    module_eval_ms: num(o.module_eval_ms, "module_eval_ms", { min: Number.MIN_VALUE }),
    registration_ms: num(o.registration_ms, "registration_ms", { min: Number.MIN_VALUE }),
    tools_list_ms: num(o.tools_list_ms, "tools_list_ms", { min: 0 }),
    tools_registered: tools,
  };
}

export function collectBoot(spawn: SpawnBootProbe = spawnBootProbe): MetricSample[] {
  // parseProbe validates every field and throws on a zero tool count or a non-positive duration:
  // a run that registered nothing would otherwise report superb timings, and a hard/exact 0 would
  // match a baseline 0 forever — the measures-nothing-while-green failure family 15 also refuses.
  const r = parseProbe(spawn());

  return [
    {
      // The only deterministic number here, so it carries the hard gate. It also pins the
      // module-registrar surface: adding a tool to a module moves it and demands a deliberate
      // re-record, exactly like the densification edge counts.
      key: "boot.tools_registered",
      value: r.tools_registered,
      unit: "count",
      class: "hard",
      direction: "exact",
    },
    {
      // The dominant term, and the one a cold-start proposal must actually move. Warn-class
      // because it is wall time on a shared runner — see the README's Determinism section for why
      // no latency figure in this harness is gated hard.
      key: "boot.module_eval_ms",
      value: r.module_eval_ms,
      unit: "ms",
      class: "warn",
      direction: "higher-worse",
    },
    {
      // Builds ~148 tools and their Zod schemas. Distinct from module_eval because the fixes are
      // distinct: deferred/generated schemas (THE-513) move this one, dynamic imports move the
      // other, and a single blended number would hide which lever did anything.
      key: "boot.registration_ms",
      value: r.registration_ms,
      unit: "ms",
      class: "warn",
      direction: "higher-worse",
    },
    {
      key: "boot.tools_list_ms",
      value: r.tools_list_ms,
      unit: "ms",
      class: "warn",
      direction: "higher-worse",
    },
  ];
}
