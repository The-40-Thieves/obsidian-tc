// toolFacade.explainAutoMode — the observability layer over `toolFacade.mode: "auto"`. The
// decision itself is untouched (pure observability): these tests pin (1) the explanation names the
// signals the matcher actually reads and changes when each one changes, (2) the decision is
// byte-identical with the flag on and off, (3) the log line exists only when the flag is on, and
// (4) the explanation reaches server_health for the calling client.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toolFacadeCheck } from "../src/doctor/tool-facade";
import {
  BUILTIN_AUTO_FACADE_CLIENTS,
  explainAutoFacadeMode,
  resolveAutoFacadeMode,
} from "../src/mcp/facade-auto";
import { createFacadeModeResolver } from "../src/mcp/facade-mode-resolver";
import type { CallerContext } from "../src/mcp/registry";
import { ToolRegistry } from "../src/mcp/registry";
import { createMcpServer } from "../src/mcp/server";
import { createHealthTool } from "../src/tools/admin/health";

const stubServer = (): Server => ({ getClientVersion: () => undefined }) as unknown as Server;

describe("explainAutoFacadeMode — the explanation follows each signal", () => {
  it("a client with no name: rule no-client-name, fallback triad", () => {
    const e = explainAutoFacadeMode(undefined);
    expect(e).toMatchObject({ rule: "no-client-name", mode: "triad", fallback: "triad" });
    expect(e.clientName).toBeUndefined();
    expect(e.matchedKey).toBeUndefined();
  });

  it("a built-in client (claude-code, which ships its own tool search): built-in-table -> triad", () => {
    const e = explainAutoFacadeMode("Claude-Code");
    expect(e).toMatchObject({
      rule: "built-in-table",
      matchedKey: "claude-code",
      mode: "triad",
      clientName: "Claude-Code",
    });
    expect(e.builtInKeys).toEqual(BUILTIN_AUTO_FACADE_CLIENTS.map(([k]) => k));
  });

  it("a client with no tool-search entry and no match: no-match fallback -> triad", () => {
    const e = explainAutoFacadeMode("some-unknown-client");
    expect(e).toMatchObject({ rule: "no-match", mode: "triad", clientName: "some-unknown-client" });
    expect(e.matchedKey).toBeUndefined();
  });

  it("setting an override changes the rule, the matched key and the mode", () => {
    const before = explainAutoFacadeMode("claude-code");
    const after = explainAutoFacadeMode("claude-code", { "claude-code": "flat" });
    expect(before.rule).toBe("built-in-table");
    expect(after).toMatchObject({
      rule: "configured-override",
      matchedKey: "claude-code",
      mode: "flat",
      configuredKeys: ["claude-code"],
    });
    expect(after).not.toEqual(before);
  });

  it("overrides are listed in the config's own key order; first match wins", () => {
    const e = explainAutoFacadeMode("my-claude-code-fork", {
      claude: "flat",
      "claude-code": "triad",
    });
    expect(e.configuredKeys).toEqual(["claude", "claude-code"]);
    expect(e).toMatchObject({ rule: "configured-override", matchedKey: "claude", mode: "flat" });
  });

  it("an override that matches nothing is still listed but does not fire", () => {
    const e = explainAutoFacadeMode("cursor", { zed: "flat" });
    expect(e).toMatchObject({ rule: "built-in-table", matchedKey: "cursor", mode: "triad" });
    expect(e.configuredKeys).toEqual(["zed"]);
  });

  it("a non-string clientName is treated as absent, never thrown on", () => {
    expect(explainAutoFacadeMode(42 as unknown as string).rule).toBe("no-client-name");
  });
});

describe("the decision is byte-identical with the flag on and off", () => {
  const names = [undefined, "", "claude-code", "CLAUDE-CODE-2", "cursor", "zed", "x".repeat(300)];
  const overrideSets: Array<Record<string, "triad" | "domain" | "flat"> | undefined> = [
    undefined,
    {},
    { "claude-code": "flat" },
    { zed: "domain", cursor: "flat" },
  ];

  it("resolveAutoFacadeMode === explainAutoFacadeMode(...).mode for every input", () => {
    for (const n of names)
      for (const o of overrideSets)
        expect(explainAutoFacadeMode(n, o).mode).toBe(resolveAutoFacadeMode(n, o));
  });

  it("the resolver returns the same mode sequence with the flag on as off (cache included)", () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      for (const o of overrideSets) {
        const seq = [undefined, "zed", "claude-code", undefined, "cursor"];
        const off = createFacadeModeResolver(stubServer(), { facadeMode: "auto", autoClients: o });
        const on = createFacadeModeResolver(stubServer(), {
          facadeMode: "auto",
          autoClients: o,
          explainAutoMode: true,
        });
        expect(seq.map((n) => on.resolveFacadeMode(n))).toEqual(
          seq.map((n) => off.resolveFacadeMode(n)),
        );
      }
    } finally {
      writeSpy.mockRestore();
    }
  });
});

describe("createFacadeModeResolver — explanation log + ctx field", () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    writeSpy.mockRestore();
  });
  // The explain log de-dupes at module scope (like the resolution log), so each test uses its own
  // distinct client name.
  const explainLines = (): string[] =>
    writeSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((l: string) => l.includes("toolFacade.explain"));

  it("flag off: no explanation line and no ctx field", () => {
    const r = createFacadeModeResolver(stubServer(), { facadeMode: "auto" });
    r.resolveFacadeMode("explain-off-client");
    expect(explainLines()).toHaveLength(0);
    expect(r.ctxExplanation()).toEqual({});
  });

  it("flag on: exactly one structured JSON line per resolution, carrying the explanation", () => {
    const r = createFacadeModeResolver(stubServer(), { facadeMode: "auto", explainAutoMode: true });
    r.resolveFacadeMode("explain-on-client");
    r.resolveFacadeMode("explain-on-client"); // cached: no second line
    const lines = explainLines();
    expect(lines).toHaveLength(1);
    const line = lines[0] as string;
    expect(line.endsWith("\n")).toBe(true);
    const json = JSON.parse(line.slice(line.indexOf("{")));
    expect(json).toMatchObject({
      clientName: "explain-on-client",
      rule: "no-match",
      mode: "triad",
    });
    expect(r.ctxExplanation()).toEqual({ facadeExplanation: json });
  });

  it("flag on: the line carries no secrets — a forged client name cannot forge a second line", () => {
    const r = createFacadeModeResolver(stubServer(), { facadeMode: "auto", explainAutoMode: true });
    r.resolveFacadeMode("forged\ntoolFacade.explain {}\x00\x1b[31m");
    const line = explainLines()[0] as string;
    expect(line.split("\n")).toHaveLength(2);
    expect(line).not.toContain("\x00");
    expect(line).not.toContain("\x1b");
  });

  it("flag on: a nameless resolution is explained (no-client-name) and replaced once a name arrives", () => {
    const r = createFacadeModeResolver(stubServer(), { facadeMode: "auto", explainAutoMode: true });
    r.resolveFacadeMode(undefined);
    expect(r.ctxExplanation().facadeExplanation?.rule).toBe("no-client-name");
    r.resolveFacadeMode("claude-code");
    expect(r.ctxExplanation().facadeExplanation?.rule).toBe("built-in-table");
  });

  it("flag on with a concrete (non-auto) mode: nothing was auto-decided, so nothing to explain", () => {
    const r = createFacadeModeResolver(stubServer(), {
      facadeMode: "domain",
      explainAutoMode: true,
    });
    expect(r.resolveFacadeMode("explain-fixed-client")).toBe("domain");
    expect(explainLines()).toHaveLength(0);
    expect(r.ctxExplanation()).toEqual({});
  });
});

describe("server_health surfaces the calling client's explanation", () => {
  const reg = (profile: "full" | "core"): ToolRegistry => {
    const r = new ToolRegistry();
    r.register(
      createHealthTool({
        version: "test",
        vaults: ["v1"],
        startedAt: 0,
        nativeLoaded: false,
        vecEnabled: false,
        toolFacade: { configured: "auto", profile },
      }),
    );
    return r;
  };

  async function health(
    clientName: string,
    o: {
      explainAutoMode?: boolean;
      autoClients?: Record<string, "triad" | "domain" | "flat">;
      profile?: "full" | "core";
    },
  ) {
    const server = createMcpServer({
      name: "x",
      version: "0",
      registry: reg(o.profile ?? "core"),
      context: (): CallerContext => ({
        caller: "stdio",
        authenticated: true,
        grantedScopes: new Set(["*"]),
        vaultId: "v1",
        db: {} as never,
      }),
      visibility: { grantedScopes: new Set(["*"]) },
      facadeMode: "auto",
      autoClients: o.autoClients,
      explainAutoMode: o.explainAutoMode,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: clientName, version: "1.0" });
    await client.connect(ct);
    const res = await client.callTool({ name: "server_health", arguments: {} });
    await client.close();
    await server.close();
    const content = (res as unknown as { content: [{ text: string }] }).content;
    return JSON.parse(content[0].text).toolFacade as {
      effective: string;
      explanation?: Record<string, unknown>;
    };
  }

  beforeEach(() => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("flag off: no explanation in the block (today's shape is unchanged)", async () => {
    const tf = await health("health-off-client", {});
    expect(tf).not.toHaveProperty("explanation");
  });

  it("flag on: the explanation follows the client, the override set — and NOT the profile", async () => {
    const cc = await health("claude-code", { explainAutoMode: true });
    const other = await health("health-other-client", { explainAutoMode: true });
    const overridden = await health("claude-code", {
      explainAutoMode: true,
      autoClients: { "claude-code": "flat" },
    });
    expect(cc.explanation).toMatchObject({ rule: "built-in-table", mode: "triad" });
    expect(other.explanation).toMatchObject({ rule: "no-match", mode: "triad" });
    expect(overridden.explanation).toMatchObject({ rule: "configured-override", mode: "flat" });
    expect(overridden.effective).toBe("flat");
    // `toolFacade.profile` is not an input to the decision, so the explanation must not move with it.
    const full = await health("claude-code", { explainAutoMode: true, profile: "full" });
    expect(full.explanation).toEqual(cc.explanation);
    expect(full.effective).toBe(cc.effective);
  });
});

describe("toolFacade.doctor reports the flag", () => {
  const run = (v: Parameters<typeof toolFacadeCheck>[0]) =>
    toolFacadeCheck(v).run({ serverVersion: "test" });

  it("auto mode + flag on: (deprecation warning) flag visible in details", async () => {
    const r = await run({ configured: "auto", profile: "full", explainAutoMode: true });
    expect(r.status).toBe("warning");
    expect(r.summary).toContain("deprecated");
    expect(r.details?.explainAutoMode).toBe("on");
  });

  it("flag unset: details say off", async () => {
    const r = await run({ configured: "auto", profile: "full" });
    expect(r.details?.explainAutoMode).toBe("off");
  });

  it("flag on under a concrete mode is inert: warning", async () => {
    const r = await run({ configured: "triad", profile: "full", explainAutoMode: true });
    expect(r.status).toBe("warning");
    expect(r.summary).toContain("explainAutoMode");
  });
});
