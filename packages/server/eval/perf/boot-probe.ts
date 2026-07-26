// THE-515 (family 16): the cold-boot probe. Runs in a FRESH subprocess and prints one JSON line.
//
// It has to be a subprocess, and that is the whole reason this file exists rather than being a
// function in collectors/boot.ts: you cannot time cold module evaluation from inside a process
// that has already imported the modules. By the time any collector runs, the harness has long
// since pulled in the tool surface, so an in-process measurement would report warm-cache numbers
// and quietly understate the dominant term.
//
// WHAT THIS MEASURES AND WHY THOSE THREE STAGES. Measured 2026-07-26 on THE-515: cold start is
// ~290ms for the bundled artifact and ~83% of it is module load/evaluation, while every subsystem
// that ticket proposed to lazy-initialize (embedding provider, sqlite-vec, the native binding, the
// registry object) costs ~13ms COMBINED. So the stages worth watching are the import graph and
// registration, not subsystem construction — and gating them is what would have caught that
// ticket's premise before it was written.
//
// Deps are stubbed. Tool builders construct Zod schemas at build time and only touch `deps` inside
// handlers, so a stub is enough to pay the real registration cost without standing up a vault,
// embedding provider or database. Verified: all eight modules register cleanly this way, and they
// still do when the stub THROWS on call (see STRICT_DEPS) — which is what makes that a real drift
// guard rather than a comment. A stub that quietly returned undefined would let a future builder
// do construction-time work for free and report a cheaper registration than production pays.
import { performance } from "node:perf_hooks";

export interface BootProbeResult {
  /** Importing the tool surface + registry: the transitive graph, cold. The dominant term. */
  module_eval_ms: number;
  /** Running every register*Tools function: builds ~148 tools and their Zod schemas. */
  registration_ms: number;
  /** First `tools/list` after registration: visibility filtering PLUS the per-tool MCP schema
   *  projection (`toMcpTool`), which is what the request path at mcp/server.ts actually does.
   *  Timing `registry.list()` alone would measure a map copy and stay flat through a regression in
   *  the projection — the expensive half. Pagination and caller-context resolution are excluded:
   *  those need a live server, and this probe deliberately stands up no transport. */
  tools_list_ms: number;
  /** Tools registered by the module registrars. Deterministic, and the guard that this probe did
   *  real work: a probe that registered nothing would otherwise report excellent timings.
   *
   *  NOTE this is NOT the 150 that check-version-coherence tracks. Two tools (health,
   *  index_status) are registered inline in cli.ts from live runtime state rather than by a module
   *  registrar, and cannot be built from a stub. 148 + 2 = 150. */
  tools_registered: number;
}

/** Every module registrar, named explicitly rather than discovered, so ADDING a module is a
 *  deliberate edit here instead of a silent change in what "boot" means. */
const MODULES = ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"] as const;

/** Dep stub that THROWS when a builder calls it. Registration is supposed to be pure schema
 *  construction; anything that invokes a dependency at build time is doing work production pays
 *  for and this probe would otherwise measure for free. Confirmed against all eight registrars:
 *  148 tools still build with this stub, so nothing legitimate calls deps at construction time
 *  today, and the day something starts the probe fails loudly instead of under-reporting. */
const STRICT_DEPS = new Proxy(
  {},
  {
    get: (_target, prop) =>
      new Proxy(() => undefined, {
        get: () => undefined,
        apply: () => {
          throw new Error(
            `boot probe: deps.${String(prop)}() was CALLED during registration. Registration is meant to be pure schema construction — this probe would otherwise report a cheaper boot than production pays.`,
          );
        },
      }),
  },
) as never;

export async function runBootProbe(): Promise<BootProbeResult> {
  const deps = STRICT_DEPS;

  const t0 = performance.now();
  const { ToolRegistry } = await import("../../src/mcp/registry");
  const registrars: Array<(r: InstanceType<typeof ToolRegistry>, d: never) => void> = [];
  for (const m of MODULES) {
    const mod = (await import(`../../src/tools/${m}/index`)) as Record<string, unknown>;
    const entry = Object.entries(mod).find(([k]) => k.startsWith("register"));
    if (!entry)
      throw new Error(
        `boot probe: tools/${m}/index exports no register* function — the probe would measure a stage that no longer exists`,
      );
    registrars.push(entry[1] as (r: InstanceType<typeof ToolRegistry>, d: never) => void);
  }
  const moduleEvalMs = performance.now() - t0;

  const registry = new ToolRegistry({});
  const t1 = performance.now();
  for (const register of registrars) register(registry, deps);
  const registrationMs = performance.now() - t1;

  // The real tools/list shape: filter by caller visibility, then project each definition to its
  // MCP wire form. A full grant is used so nothing is filtered out — the point is to pay the whole
  // projection cost, not to model a restricted caller.
  const { toMcpTool } = await import("../../src/mcp/server");
  const t2 = performance.now();
  const visible = registry.listVisible({ grantedScopes: new Set(["*"]), readOnly: false });
  const projected = visible.map(toMcpTool);
  const toolsListMs = performance.now() - t2;

  return {
    module_eval_ms: moduleEvalMs,
    registration_ms: registrationMs,
    tools_list_ms: toolsListMs,
    // Counted from the PROJECTED list: that is the surface a client actually receives, so a
    // projection that silently dropped tools would move this number rather than hide behind a
    // healthy registry count.
    tools_registered: projected.length,
  };
}

// Only when run directly as a subprocess (collectors/boot.ts spawns it); importing for tests does
// not print. The single JSON line on stdout IS the protocol — the collector parses the last line,
// so any diagnostic must go to stderr.
if ((import.meta as unknown as { main?: boolean }).main) {
  runBootProbe()
    .then((r) => process.stdout.write(`${JSON.stringify(r)}\n`))
    .catch((e: unknown) => {
      process.stderr.write(`boot probe failed: ${e instanceof Error ? e.stack : String(e)}\n`);
      process.exit(1);
    });
}
