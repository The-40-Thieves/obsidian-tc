// THE-688 fix 2 — the opt-in dense liveness probe.
//
// Fix 1 stopped doctor CLAIMING readiness it never checked (`ready` was a literal with no branch).
// It could not prevent the outage that motivated the ticket: Ollama was removed while the config
// still named it, and for two days every semantic query failed while doctor exited 0. This is the
// half that catches that — but only when explicitly asked, because a diagnostic that reaches the
// network as a side effect of being run is a different tool than the one people reach for when
// something is already broken.
//
// The invariant these tests exist to hold: `ready` appears ONLY on the probed path. Everywhere
// else the wording must stay `configured`.
import { describe, expect, it } from "vitest";
import { type RetrievalHeadsView, retrievalHeadsCheck } from "../src/doctor/retrieval-heads";
import type { DoctorContext } from "../src/doctor/types";

const ctx: DoctorContext = { serverVersion: "test" };

const view = (over: Partial<RetrievalHeadsView> = {}): RetrievalHeadsView => ({
  denseProvider: "openai",
  denseModel: "text-embedding-3-small",
  denseDimensions: 1536,
  multiVector: false,
  sparseEnabled: false,
  colbertEnabled: false,
  ...over,
});

describe("THE-688 fix 2: retrieval.heads under --probe", () => {
  it("without a probe, stays offline and never claims readiness", async () => {
    const r = await retrievalHeadsCheck(view()).run(ctx);
    expect(r.status).toBe("ok");
    expect(r.details?.dense).toContain("configured");
    expect(r.details?.dense).toContain("not probed");
    expect(r.details?.dense).not.toMatch(/\bREADY\b|\bready\b/);
    expect(r.summary).toContain("not probed");
  });

  it("a SUCCESSFUL probe is the only thing that may say READY, and reports the latency", async () => {
    const r = await retrievalHeadsCheck(view({ probe: async () => ({ ok: true, ms: 42 }) })).run(
      ctx,
    );
    expect(r.status).toBe("ok");
    expect(r.details?.dense).toContain("READY");
    expect(r.details?.dense).toContain("42ms");
    // Latency is reported because "reachable" and "reachable but pathologically slow" read
    // identically in a boolean, and only one of them is fine.
    expect(r.details?.dense).not.toContain("not probed");
    expect(r.summary).toContain("PROBED ok");
  });

  it("a SLOW but successful probe stays ok and adds a note — reachable is not the same as usable", async () => {
    // Measured on a real gateway: a cold bge-m3 answered in 89,475ms. Capping the probe would
    // report UNREACHABLE for a provider that works, which is a worse error than the ambiguity
    // this ticket removes. It stays `ok`; the note is what makes the latency visible.
    const r = await retrievalHeadsCheck(
      view({ probe: async () => ({ ok: true, ms: 89_475 }) }),
    ).run(ctx);
    expect(r.status).toBe("ok");
    expect(r.details?.dense).toContain("READY");
    expect(r.notes?.join(" ")).toContain("89475ms");
    expect(r.issues ?? []).toHaveLength(0);
  });

  it("a fast probe earns no slowness note", async () => {
    const r = await retrievalHeadsCheck(view({ probe: async () => ({ ok: true, ms: 12 }) })).run(
      ctx,
    );
    expect(r.status).toBe("ok");
    expect(r.notes?.join(" ") ?? "").not.toContain("took");
  });

  it("a FAILED probe warns, names the reason, and does not fail the whole run", async () => {
    const r = await retrievalHeadsCheck(
      view({ probe: async () => ({ ok: false, reason: "fetch failed: ECONNREFUSED" }) }),
    ).run(ctx);
    // WARNING, not fail: the config is valid and the server still boots. What changed is that
    // retrieval will degrade — which is exactly the condition that went unnoticed for two days.
    expect(r.status).toBe("warning");
    expect(r.details?.dense).toContain("UNREACHABLE");
    expect(r.details?.dense).toContain("ECONNREFUSED");
    expect(r.issues?.join(" ")).toContain("did not answer a probe");
  });

  it("names the RIGHT failure — an unreachable provider is not an inert-stream problem", async () => {
    // Both land as `warning`. Before this, the single warning summary said "a retrieval stream is
    // enabled but inert", and the remediation said "set embeddings.provider to bge-m3" — advice
    // that sends an operator to rewrite a perfectly good config while the endpoint stays down.
    const unreachable = await retrievalHeadsCheck(
      view({ probe: async () => ({ ok: false, reason: "connect ETIMEDOUT" }) }),
    ).run(ctx);
    expect(unreachable.summary).toContain("did not answer a probe");
    expect(unreachable.summary).not.toContain("inert");
    expect(unreachable.remediation).toContain("reachable");
    expect(unreachable.remediation).not.toContain("bge-m3");

    const inert = await retrievalHeadsCheck(view({ sparseEnabled: true })).run(ctx);
    expect(inert.summary).toContain("inert");
    expect(inert.remediation).toContain("bge-m3");
  });

  it("the summary is driven by a flag set at the failure, not by sniffing the rendered string", async () => {
    // Regression guard for how this is wired: re-deriving `probeFailed` from
    // details.dense.startsWith("UNREACHABLE") would make rewording the detail silently change
    // which summary an operator sees. A probe failure must still be reported as one even if the
    // detail text is edited, so assert the pair moves together.
    const r = await retrievalHeadsCheck(
      view({ probe: async () => ({ ok: false, reason: "no route to host" }) }),
    ).run(ctx);
    expect(r.status).toBe("warning");
    expect(r.summary).toContain("did not answer a probe");
    expect(r.details?.dense).toContain("no route to host");
  });

  it("a probe that throws is not allowed to take doctor down with it", async () => {
    // The CLI's probe never throws by construction, but the check must not assume that: the
    // framework records a fail for a throwing check, and a doctor that dies while diagnosing is
    // useless exactly when it is needed. Assert the throw propagates as a rejection the framework
    // can catch, rather than the check swallowing it into a false OK.
    await expect(
      retrievalHeadsCheck(
        view({
          probe: async () => {
            throw new Error("probe exploded");
          },
        }),
      ).run(ctx),
    ).rejects.toThrow(/probe exploded/);
  });
});
