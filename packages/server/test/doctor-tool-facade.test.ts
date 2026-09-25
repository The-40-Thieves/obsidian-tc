// toolFacade.doctor (THE-1123 part a) — doctor's own report is offline/per-server (no live MCP
// connection, so no observable clientInfo — see the check module's own comment for why this never
// reports an "effective" per-client mode the way server_health can). It reports the CONFIGURED
// mode plus the merged auto-resolution table, so an operator can reason about what an "auto"
// deployment WOULD do for a given client without needing a live connection.
import { describe, expect, it } from "vitest";
import { type ToolFacadeView, toolFacadeCheck } from "../src/doctor/tool-facade";

const ctx = { serverVersion: "test" };
const run = (view: ToolFacadeView) => toolFacadeCheck(view).run(ctx);

describe("toolFacade.doctor", () => {
  it("is ok for a concrete (non-auto) mode and names it", async () => {
    const r = await run({ configured: "triad" });
    expect(r.status).toBe("ok");
    expect(r.summary).toContain("triad");
    expect(r.details?.configured).toBe("triad");
  });

  it("is ok for auto mode and lists the EFFECTIVE (config-merged-over-built-in) table", async () => {
    const r = await run({ configured: "auto", autoClients: { cursor: "flat" } });
    expect(r.status).toBe("ok");
    expect(r.summary).toContain("auto");
    // A configured entry overrides the built-in table for the same key.
    expect(r.details?.autoClients).toContain("cursor -> flat (configured)");
    // The built-in entries not overridden are still listed, tagged as built-in.
    expect(r.details?.autoClients).toContain("claude-code -> domain (built-in)");
    expect(r.details?.autoClients).not.toContain("cursor -> triad (built-in)");
  });

  it("auto mode with no config override lists the built-in table unmodified", async () => {
    const r = await run({ configured: "auto" });
    expect(r.details?.autoClients).toEqual([
      "claude-code -> domain (built-in)",
      "cursor -> triad (built-in)",
    ]);
  });

  it("never returns fail — a facade mode is a policy choice, not a health defect", async () => {
    const r = await run({ configured: "flat" });
    expect(r.status).not.toBe("fail");
  });
});
