// toolFacade.doctor (THE-1123 part a) — doctor's own report is offline/per-server (no live MCP
// connection, so no observable clientInfo — see the check module's own comment for why this never
// reports an "effective" per-client mode the way server_health can). It reports the CONFIGURED
// mode plus the merged auto-resolution table, so an operator can reason about what an "auto"
// deployment WOULD do for a given client without needing a live connection.
import { describe, expect, it } from "vitest";
import {
  hiddenNamesInAllowlist,
  type ToolFacadeView,
  toolFacadeCheck,
} from "../src/doctor/tool-facade";
import { NON_CORE_TOOL_NAMES } from "../src/mcp/tool-profiles";

const ctx = { serverVersion: "test" };
const run = (view: ToolFacadeView) => toolFacadeCheck(view).run(ctx);

describe("toolFacade.doctor", () => {
  it("is ok for a concrete (non-auto) mode and names it", async () => {
    const r = await run({ configured: "triad", profile: "core" });
    expect(r.status).toBe("ok");
    expect(r.summary).toContain("triad");
    expect(r.details?.configured).toBe("triad");
  });

  it("is ok for auto mode and lists the EFFECTIVE (config-merged-over-built-in) table", async () => {
    const r = await run({ configured: "auto", profile: "core", autoClients: { cursor: "flat" } });
    expect(r.status).toBe("ok");
    expect(r.summary).toContain("auto");
    // A configured entry overrides the built-in table for the same key.
    expect(r.details?.autoClients).toContain("cursor -> flat (configured)");
    // The built-in entries not overridden are still listed, tagged as built-in.
    expect(r.details?.autoClients).toContain("claude-code -> domain (built-in)");
    expect(r.details?.autoClients).not.toContain("cursor -> triad (built-in)");
  });

  it("auto mode with no config override lists the built-in table unmodified", async () => {
    const r = await run({ configured: "auto", profile: "core" });
    expect(r.details?.autoClients).toEqual([
      "claude-code -> domain (built-in)",
      "cursor -> triad (built-in)",
    ]);
  });

  it("never returns fail — a facade mode is a policy choice, not a health defect", async () => {
    const r = await run({ configured: "flat", profile: "core" });
    expect(r.status).not.toBe("fail");
  });

  // THE-1123 review fix (LOW #9): `toolFacade.autoClients` is only ever consulted when `mode` is
  // "auto" (mcp/server.ts's `resolveFacadeMode` short-circuits before touching it otherwise) — a
  // config that sets `autoClients` under a concrete mode is silently inert, which doctor should
  // surface rather than stay quiet about.
  it("WARNS when autoClients is configured but mode is not auto — it is silently ignored", async () => {
    const r = await run({ configured: "triad", profile: "core", autoClients: { cursor: "flat" } });
    expect(r.status).toBe("warning");
    expect(r.summary).toContain("autoClients");
    expect(r.remediation).toBeTruthy();
  });

  it("does NOT warn when autoClients is absent under a concrete mode", async () => {
    const r = await run({ configured: "domain", profile: "core" });
    expect(r.status).toBe("ok");
  });

  it("does NOT warn when autoClients is an empty object under a concrete mode", async () => {
    const r = await run({ configured: "flat", profile: "core", autoClients: {} });
    expect(r.status).toBe("ok");
  });

  // Review round 2: an allowlist naming a tool `toolFacade.profile: "core"` hides is dead
  // config — the profile wins, so the allowlist entry can never restore access.
  it("WARNS when an allowlist names a tool toolFacade.profile hides", async () => {
    const r = await run({
      configured: "triad",
      profile: "core",
      hiddenAllowlistEntries: [{ source: "toolVisibility.allowed", names: ["create_excalidraw"] }],
    });
    expect(r.status).toBe("warning");
    expect(r.summary).toContain("allowlist");
    expect(r.details?.hiddenAllowlistEntries).toBeTruthy();
  });

  it("does NOT warn when profile is full even if an allowlist entry would collide", async () => {
    const r = await run({
      configured: "triad",
      profile: "full",
      hiddenAllowlistEntries: [{ source: "toolVisibility.allowed", names: [] }],
    });
    expect(r.status).toBe("ok");
  });
});

describe("hiddenNamesInAllowlist", () => {
  it("returns the intersection with NON_CORE_TOOL_NAMES only under profile core", () => {
    const hidden = NON_CORE_TOOL_NAMES[0] as string;
    expect(hiddenNamesInAllowlist([hidden, "read_note"], "core")).toEqual([hidden]);
    expect(hiddenNamesInAllowlist([hidden, "read_note"], "full")).toEqual([]);
    expect(hiddenNamesInAllowlist(undefined, "core")).toEqual([]);
  });
});
