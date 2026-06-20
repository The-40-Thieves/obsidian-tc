import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type ServerConfig, ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { ToolRegistry } from "../src/mcp/registry";
import { createHealthTool } from "../src/tools/admin/health";
import { checkHttpBindSafety, isLoopbackHost, startHttp } from "../src/transports/http";
import { openMemoryDb } from "./helpers";

// F2: auth.mode "none" grants scope ["*"] to every HTTP caller, so a non-loopback
// bind without an explicit opt-in must refuse to start. Loopback + none (local dev)
// and any jwt bind must be unaffected, and the opt-in must bind with one warning.

const schemaSql = readFileSync(
  fileURLToPath(new URL("../src/schema.sql", import.meta.url)),
  "utf8",
);

function authOf(input: unknown): ServerConfig["auth"] {
  return ServerConfigSchema.parse({ vaults: [{ id: "v1", path: "/tmp/v1" }], auth: input }).auth;
}

function bootArgs(o: {
  auth: ServerConfig["auth"];
  host: string;
  insecure?: boolean;
  onWarn?: (line: string) => void;
}) {
  const db = openMemoryDb();
  db.exec(schemaSql);
  const registry = new ToolRegistry();
  registry.register(
    createHealthTool({ version: "0.0.0-test", vaults: ["v1"], startedAt: Date.now() }),
  );
  return {
    name: "obsidian-tc",
    version: "0.0.0-test",
    registry,
    auth: o.auth,
    db,
    vaultId: "v1",
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    host: o.host,
    port: 0,
    insecure: o.insecure,
    onWarn: o.onWarn,
  };
}

describe("isLoopbackHost", () => {
  it("accepts every loopback form", () => {
    for (const h of [
      "127.0.0.1",
      "127.0.0.5",
      "::1",
      "[::1]",
      "localhost",
      "LOCALHOST",
      "::ffff:127.0.0.1",
    ])
      expect(isLoopbackHost(h)).toBe(true);
  });
  it("rejects non-loopback / all-interfaces forms", () => {
    for (const h of ["0.0.0.0", "::", "192.168.1.10", "10.0.0.1", "example.com"])
      expect(isLoopbackHost(h)).toBe(false);
  });
});

describe("checkHttpBindSafety (F2)", () => {
  it("refuses auth none on a non-loopback host without opt-in", () => {
    const r = checkHttpBindSafety({ authMode: "none", host: "0.0.0.0" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/refusing to start/);
  });
  it("allows auth none on loopback (no warning)", () => {
    expect(checkHttpBindSafety({ authMode: "none", host: "127.0.0.1" })).toEqual({ ok: true });
  });
  it("allows a non-loopback bind with insecure opt-in but returns a warning", () => {
    const r = checkHttpBindSafety({ authMode: "none", host: "0.0.0.0", insecure: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning).toMatch(/UNAUTHENTICATED/);
  });
  it("does not constrain jwt mode on a non-loopback host", () => {
    expect(checkHttpBindSafety({ authMode: "jwt", host: "0.0.0.0" })).toEqual({ ok: true });
  });
});

describe("startHttp bind-safety enforcement (F2)", () => {
  it("auth none + non-loopback refuses to start (throws before binding)", () => {
    expect(() => startHttp(bootArgs({ auth: authOf({ mode: "none" }), host: "0.0.0.0" }))).toThrow(
      /refusing to start/,
    );
  });

  it("auth none + loopback starts unchanged (local dev)", async () => {
    const handle = await startHttp(bootArgs({ auth: authOf({ mode: "none" }), host: "127.0.0.1" }));
    expect(handle.port).toBeGreaterThan(0);
    await handle.close();
  });

  it("insecure opt-in + non-loopback starts and emits exactly one warning", async () => {
    const warnings: string[] = [];
    const handle = await startHttp(
      bootArgs({
        auth: authOf({ mode: "none" }),
        host: "0.0.0.0",
        insecure: true,
        onWarn: (l) => warnings.push(l),
      }),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/\[SECURITY\]/);
    await handle.close();
  });

  it("auth jwt + non-loopback is unaffected (starts, no warning)", async () => {
    const warnings: string[] = [];
    const handle = await startHttp(
      bootArgs({
        auth: authOf({ mode: "jwt", jwtSecret: "s".repeat(40) }),
        host: "0.0.0.0",
        onWarn: (l) => warnings.push(l),
      }),
    );
    expect(warnings).toHaveLength(0);
    expect(handle.port).toBeGreaterThan(0);
    await handle.close();
  });
});
