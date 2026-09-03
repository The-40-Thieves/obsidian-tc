// The floor for derived.column-liveness (THE-720).
//
// A scan that covers nothing reports success. `check:*` gates in this repo have already shipped in
// that state twice, which is why every source-scan gate here carries an explicit non-empty floor
// and is watched failing before it is trusted. The check itself cannot supply the floor — it is
// handed whatever the spec produced — so the spec is pinned here.
import { describe, expect, it } from "vitest";
import { experientialColumnSpec } from "../src/doctor/column-spec";

describe("derived.column-liveness spec", () => {
  it("covers a non-empty set of columns", () => {
    expect(experientialColumnSpec({ experiential: true }).length).toBeGreaterThanOrEqual(6);
  });

  it("names the columns THE-718 and THE-720 were opened about", () => {
    const names = experientialColumnSpec({ experiential: true }).map(
      (s) => `${s.table}.${s.column}`,
    );
    expect(names).toContain("chunk_retrievals.feedback");
    expect(names).toContain("agent_episodes.task_result");
    // THE-718: `chunk_retrievals.outcome` was the column this check was opened about, and reading
    // it dead is what retired it (20260806_001). The spec must no longer name it — a spec entry
    // for a dropped column makes the doctor query a column that does not exist.
    expect(names).not.toContain("chunk_retrievals.outcome");
    expect(names).not.toContain("agent_episodes.outcome");
  });

  // Without at least one column that IS reliably written, a green run proves only that the scan
  // found nothing — the same reason derived.liveness deliberately includes tables that are healthy.
  // These are the entries that make a passing result mean something.
  it("includes columns known to be written, so `live` can be non-empty", () => {
    const live = experientialColumnSpec({ experiential: true }).filter(
      (s) => s.writer === "enabled",
    );
    expect(live.length).toBeGreaterThanOrEqual(2);
    expect(live.map((s) => `${s.table}.${s.column}`)).toContain("agent_episodes.status");
  });

  // THE-752: `summary` gained a producer (the deterministic Tier 0 receipt writer in
  // evaluateEpisodes) alongside `task_result`'s THE-726 producer — both now report "enabled" when
  // the experiential store is on, "disabled" (not "none") when it is off, since a real writer
  // exists and configuration is what gates it.
  it("classifies columns with a real producer as `enabled`, gated on config, not `none`", () => {
    const spec = experientialColumnSpec({ experiential: true });
    const byName = (n: string) => spec.find((s) => `${s.table}.${s.column}` === n);
    expect(byName("agent_episodes.task_result")?.writer).toBe("enabled");
    expect(byName("agent_episodes.summary")?.writer).toBe("enabled");
  });

  // THE-726 (on-demand derivation): the two new provenance columns must be present and classified
  // the same way task_result is — a real producer exists, config gates it.
  it("names and classifies the THE-726 provenance columns", () => {
    const spec = experientialColumnSpec({ experiential: true });
    const byName = (n: string) => spec.find((s) => `${s.table}.${s.column}` === n);
    expect(byName("agent_episodes.verdict_source")?.writer).toBe("enabled");
    expect(byName("agent_episodes.verdict_policy")?.writer).toBe("enabled");
  });

  // The emitter for feedback is a client action (THE-718: the acting agent stamps it), so
  // an unstamped column is "awaiting its first use", not a fault. Classifying it "enabled" would
  // warn on day one of a correct deployment — the exact cry-wolf failure derived.liveness was
  // rewritten to avoid when it produced eleven warnings on a healthy install.
  it("classifies client-driven columns as on-demand so they report without warning", () => {
    const spec = experientialColumnSpec({ experiential: true });
    const byName = (n: string) => spec.find((s) => `${s.table}.${s.column}` === n);
    expect(byName("chunk_retrievals.feedback")?.writer).toBe("on-demand");
    expect(byName("chunk_retrievals.citation_state")?.writer).toBe("on-demand");
  });

  it("reports every column as disabled when the experiential store is off", () => {
    const spec = experientialColumnSpec({ experiential: false });
    // A store that is switched off cannot be a finding — except for columns nothing writes at all,
    // which stay structurally unwritten regardless of configuration.
    for (const s of spec) expect(["disabled", "none"]).toContain(s.writer);
    expect(spec.some((s) => s.writer === "disabled")).toBe(true);
  });

  it("gives every column a lever an operator can act on", () => {
    for (const s of experientialColumnSpec({ experiential: true })) {
      expect(s.lever.length).toBeGreaterThan(10);
    }
  });
});
