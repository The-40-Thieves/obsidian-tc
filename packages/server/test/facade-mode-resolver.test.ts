// THE-1123 review fixes (MEDIUM #3, #4) — createFacadeModeResolver's own unit coverage, isolated
// from the full stdio/HTTP pipeline: caching behavior when a request carries no observable
// clientInfo, and the info-level resolution log's sanitization + de-duplication.
import type { Server } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFacadeModeResolver } from "../src/mcp/facade-mode-resolver";

function stubServer(clientVersion?: { name: string; version?: string }): Server {
  return { getClientVersion: () => clientVersion } as unknown as Server;
}

describe("createFacadeModeResolver — caching (THE-1123 review fix MEDIUM #3)", () => {
  it("does NOT cache a nameless resolution — a later NAMED call still resolves for real", () => {
    const resolver = createFacadeModeResolver(stubServer(), { facadeMode: "auto" });
    expect(resolver.resolveFacadeMode(undefined)).toBe("triad"); // the fallback, uncached
    expect(resolver.resolveFacadeMode("claude-code")).toBe("domain"); // real resolution now
    // And it stays cached from here — a later nameless call gets the CACHED real answer, not a
    // re-derived fallback.
    expect(resolver.resolveFacadeMode(undefined)).toBe("domain");
  });

  it("caches a named resolution on the first call — later calls (named or not) agree", () => {
    const resolver = createFacadeModeResolver(stubServer(), { facadeMode: "auto" });
    expect(resolver.resolveFacadeMode("cursor")).toBe("triad");
    // A totally different name after caching still returns the CACHED first decision — this is
    // the existing "one session, one decision" contract, unaffected by the #3 fix.
    expect(resolver.resolveFacadeMode("claude-code")).toBe("triad");
  });

  it("a non-'auto' configured mode never consults clientName or caches anything", () => {
    const resolver = createFacadeModeResolver(stubServer(), { facadeMode: "domain" });
    expect(resolver.resolveFacadeMode(undefined)).toBe("domain");
    expect(resolver.resolveFacadeMode("cursor")).toBe("domain");
  });
});

describe("createFacadeModeResolver — resolution log (THE-1123 review fix MEDIUM #4)", () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    writeSpy.mockRestore();
  });

  // NOTE: the resolution log de-dupes at MODULE scope (see the "emits once per distinct tuple"
  // tests below), which persists across test cases in this same file/process — every test in this
  // describe block therefore uses its own distinct client name so one test's log entry cannot
  // suppress another's.
  it("a client name carrying \\n and control chars produces exactly ONE sanitized line", () => {
    const forged = "admin\neffective=flat\x00\x1b[31m";
    const resolver = createFacadeModeResolver(stubServer(), { facadeMode: "auto" });
    resolver.resolveFacadeMode(forged);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const line = writeSpy.mock.calls[0]?.[0] as string;
    // Exactly one line: no embedded newline anywhere in the written string.
    expect(line.includes("\n")).toBe(true); // the ONE trailing newline this function itself adds
    expect(line.split("\n")).toHaveLength(2); // content + the trailing "" from a single \n at the end
    expect(line).not.toContain("\x00");
    expect(line).not.toContain("\x1b");
  });

  it("caps an over-long client name rather than emitting an unbounded line", () => {
    const huge = "x".repeat(200_000);
    const resolver = createFacadeModeResolver(stubServer(), { facadeMode: "auto" });
    resolver.resolveFacadeMode(huge);
    const line = writeSpy.mock.calls[0]?.[0] as string;
    expect(line.length).toBeLessThan(300); // well under the 200_000-char input
  });

  it("emits once per distinct (configured, name, effective) tuple, both within ONE resolver (repeated/cached calls) and across SEPARATE resolver instances (a fresh HTTP request per call)", () => {
    // Module-scoped dedup, not per-resolver-instance — see facade-mode-resolver.ts's own comment
    // on why a per-instance set would still spam one line per HTTP request for the same client.
    const name = "claude-code-dedup-test";
    const resolver = createFacadeModeResolver(stubServer(), { facadeMode: "auto" });
    resolver.resolveFacadeMode(name);
    resolver.resolveFacadeMode(name); // cached — resolveAutoFacadeMode not even re-run
    createFacadeModeResolver(stubServer(), { facadeMode: "auto" }).resolveFacadeMode(name); // a "new request"
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });
});

describe("createFacadeModeResolver — requestClientName (THE-1123)", () => {
  it("falls back to server.getClientVersion(), bounded the same way extractClientInfo bounds a name", () => {
    const resolver = createFacadeModeResolver(stubServer({ name: "claude-code", version: "1" }), {
      facadeMode: "auto",
    });
    expect(resolver.requestClientName(undefined, undefined)).toBe("claude-code");
  });

  it("an over-long getClientVersion().name is dropped, not truncated", () => {
    const resolver = createFacadeModeResolver(stubServer({ name: "x".repeat(129) }), {
      facadeMode: "auto",
    });
    expect(resolver.requestClientName(undefined, undefined)).toBeUndefined();
  });
});
