// THE-417 Phase 2: the seam that makes warn-mode readable.
//
// Warn-mode's job is to surface latent mismatches over real traffic. Until this landed, its only
// output was one stderr line among every other internal error — nobody greps that, so "let
// warn-mode run for a while" was not a runnable instruction. It is the same
// registered-but-never-emitting shape THE-585 found in three dead gauges.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { MetricsRecorder } from "../src/metrics/registry";
import { openMemoryDb } from "./helpers";

function ctx(): CallerContext {
  return {
    caller: "t",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: "main",
    db: openMemoryDb(),
  } as CallerContext;
}

/** A tool whose handler deliberately returns something its schema forbids. */
function driftingRegistry(opts: Partial<ConstructorParameters<typeof ToolRegistry>[0]>) {
  const r = new ToolRegistry({ strictOutputSchema: false, ...opts });
  r.register({
    name: "drifter",
    description: "returns a number where its schema promises a string",
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({ v: z.string() }),
    requiredScopes: [],
    handler: () => ({ v: 42 }) as unknown as { v: string },
  });
  return r;
}

describe("THE-417 Phase 2: output-schema drift is observable", () => {
  it("fires the drift seam in WARN mode, and still returns the payload", async () => {
    const seen: Array<[string, string]> = [];
    const res = await driftingRegistry({
      onOutputSchemaDrift: (tool, vaultId) => seen.push([tool, vaultId]),
    }).dispatch("drifter", {}, ctx());

    // Warn-mode must NOT turn a working call into a failure — that is Phase 3's job, not this one.
    expect(res.ok).toBe(true);
    expect(seen).toEqual([["drifter", "main"]]);
  });

  it("fires in STRICT mode too, so the signal is not lost where it is loudest", async () => {
    const seen: string[] = [];
    const res = await driftingRegistry({
      strictOutputSchema: true,
      onOutputSchemaDrift: (tool) => seen.push(tool),
    }).dispatch("drifter", {}, ctx());

    expect(res.ok).toBe(false);
    expect(seen).toEqual(["drifter"]);
  });

  it("stays silent when the payload matches", async () => {
    const seen: string[] = [];
    const r = new ToolRegistry({
      strictOutputSchema: false,
      onOutputSchemaDrift: (tool) => seen.push(tool),
    });
    r.register({
      name: "honest",
      description: "matches its schema",
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({ v: z.string() }),
      requiredScopes: [],
      handler: () => ({ v: "ok" }),
    });
    expect((await r.dispatch("honest", {}, ctx())).ok).toBe(true);
    expect(seen).toEqual([]);
  });

  it("never lets a throwing sink break a dispatch", async () => {
    const res = await driftingRegistry({
      onOutputSchemaDrift: () => {
        throw new Error("metrics sink is down");
      },
    }).dispatch("drifter", {}, ctx());
    expect(res.ok).toBe(true);
  });

  it("reaches the Prometheus exposition as a countable series", async () => {
    const metrics = new MetricsRecorder();
    await driftingRegistry({
      onOutputSchemaDrift: (tool, vaultId) => metrics.incOutputSchemaDrift(vaultId, tool),
    }).dispatch("drifter", {}, ctx());
    // Registration alone proves nothing — assert the VALUE, per THE-585's dead-gauge lesson.
    expect(await metrics.metrics()).toContain(
      'obsidian_tc_output_schema_drift_total{vault="main",tool="drifter"} 1',
    );
  });
});
