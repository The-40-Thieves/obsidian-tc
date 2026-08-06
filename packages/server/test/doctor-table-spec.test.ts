// The experiential TABLE spec — the companion to doctor-column-spec.test.ts, and the test that was
// missing when three entries were classified wrong.
//
// The existing derived-liveness tests exercise the CLASSIFIER with synthetic states. Nothing
// asserted the SPEC itself, so `preference_profile` could claim a scheduled producer it has never
// had and every test still passed. That gap is the whole reason this file exists.
//
// Found by a cross-vendor review on 2026-08-06 that read the SCHEDULER rather than the probe.
import { describe, expect, it } from "vitest";
import { experientialTableSpec } from "../src/doctor/table-spec";

const spec = (over: Partial<Parameters<typeof experientialTableSpec>[0]> = {}) =>
  experientialTableSpec({ experiential: true, gapSweepScheduled: false, ...over });

const writerOf = (table: string, over = {}) => spec(over).find((s) => s.table === table)?.writer;

describe("experientialTableSpec", () => {
  // The floor. A spec that covers nothing makes every downstream assertion vacuous, and the check
  // cannot supply this itself — it is handed whatever the spec produced.
  it("covers a non-empty set including the healthy baseline", () => {
    const names = spec().map((s) => s.table);
    expect(names.length).toBeGreaterThanOrEqual(9);
    // At least one table that IS written today, or a green run only proves the scan found nothing.
    expect(names).toContain("agent_episodes");
    expect(names).toContain("chunk_retrievals");
  });

  // THE-633: absent from the spec entirely, which meant the one table in this store with no
  // behavioural consumer was also the one the liveness surface never mentioned.
  it("includes goals, as on-demand", () => {
    expect(writerOf("goals")).toBe("on-demand");
  });

  // The misclassification. `enabled` asserts a producer RUNS here; extractPreferences is reachable
  // only from the manual `obsidian-tc reflect` CLI. The scheduled experiential pass is
  // evaluateEpisodes, a different function that never touches these tables.
  it("preference tables are ON-DEMAND, never enabled — extraction has no scheduled caller", () => {
    expect(writerOf("preference_profile")).toBe("on-demand");
    expect(writerOf("preference_deltas")).toBe("on-demand");
    // The control: a table that IS scheduled must still say so, or "on-demand" would just be a
    // blanket downgrade rather than a classification.
    expect(writerOf("agent_episodes")).toBe("enabled");
  });

  // gap_reports keys on the SCHEDULER GATE, not on the store being open. THE-719 registers the
  // sweep only when experiential.gapSweep.enabled is true, and that defaults to FALSE.
  it("gap_reports tracks the sweep's own gate, not merely that the store is open", () => {
    expect(writerOf("gap_reports", { gapSweepScheduled: false })).toBe("on-demand");
    expect(writerOf("gap_reports", { gapSweepScheduled: true })).toBe("enabled");
  });

  it("the lever names the actual gate, so remediation is actionable", () => {
    const off = spec({ gapSweepScheduled: false }).find((s) => s.table === "gap_reports");
    expect(off?.lever).toContain("gapSweep.enabled");
    const on = spec({ gapSweepScheduled: true }).find((s) => s.table === "gap_reports");
    expect(on?.lever).toContain("scheduled");
  });

  // Experiential off must disable EVERY entry — a spec that leaves one `enabled` would warn about
  // an empty table on a deployment that correctly never writes it.
  it("everything reports disabled when the experiential store is off", () => {
    const all = spec({ experiential: false });
    expect(all.every((s) => s.writer === "disabled")).toBe(true);
    expect(all.length).toBeGreaterThan(0); // floor, so `every` is not vacuous
  });
});
