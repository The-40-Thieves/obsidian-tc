// search.note-summaries-scale (THE-891 item 5) — is a vault's note-summary brute-force scan still
// cheap, or has it grown past the ceiling search/note-summaries.ts documents?
//
// Mirrors doctor-kb-health.test.ts's shape: not-probed -> ok, off-by-config -> ok, probed-and-under
// -> ok, probed-and-over -> warning, never fail.
import { describe, expect, it } from "vitest";
import {
  NOTE_SUMMARY_SCAN_CEILING,
  type NoteSummaryScaleState,
  noteSummaryScaleCheck,
} from "../src/doctor/note-summary-scale";

const ctx = { serverVersion: "test" };
const run = (enabled: boolean, states?: NoteSummaryScaleState[]) =>
  noteSummaryScaleCheck({ enabled, ...(states ? { probe: () => states } : {}) }).run(ctx);

describe("search.note-summaries-scale", () => {
  it("is ok and says 'off' when the summary stream is not enabled — never probed", async () => {
    const r = await run(false);
    expect(r.status).toBe("ok");
    expect(r.details?.scale).toContain("off");
  });

  it("is ok and says 'off' even if a probe were somehow attached while disabled", async () => {
    // enabled: false short-circuits before the probe is ever consulted — off means off.
    const r = await run(false, [{ vaultId: "main", count: NOTE_SUMMARY_SCAN_CEILING + 1 }]);
    expect(r.status).toBe("ok");
    expect(r.details?.scale).toContain("off");
  });

  it("is ok and says 'not probed' when enabled but no probe was attached", async () => {
    const r = await run(true);
    expect(r.status).toBe("ok");
    expect(r.details?.scale).toBe("not probed");
  });

  it("is ok when every vault is under the ceiling", async () => {
    const r = await run(true, [
      { vaultId: "main", count: 10 },
      { vaultId: "agents", count: NOTE_SUMMARY_SCAN_CEILING - 1 },
    ]);
    expect(r.status).toBe("ok");
    expect(r.summary).toContain("all under");
  });

  it("WARNS when a vault is over the ceiling, and names it", async () => {
    const over = NOTE_SUMMARY_SCAN_CEILING + 500;
    const r = await run(true, [
      { vaultId: "main", count: 10 },
      { vaultId: "agents", count: over },
    ]);
    expect(r.status).toBe("warning");
    expect(r.issues?.join(" ")).toContain("agents");
    expect(r.issues?.join(" ")).toContain(String(over));
    expect(r.remediation).toBeTruthy();
  });

  it("never returns fail — a slow brute-force scan breaks no request outright", async () => {
    const r = await run(true, [{ vaultId: "main", count: NOTE_SUMMARY_SCAN_CEILING * 100 }]);
    expect(r.status).toBe("warning");
    expect(r.status).not.toBe("fail");
  });

  it("is ok on an empty probe result — no store to inspect", async () => {
    const r = await run(true, []);
    expect(r.status).toBe("ok");
    expect(r.details?.scale).toBe("no store");
  });
});
