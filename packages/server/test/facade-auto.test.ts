// THE-1123 (part a) — the pure matcher behind `toolFacade.mode: "auto"`. See
// src/mcp/facade-auto.ts's module comment for why the built-in table is PROVISIONAL and for the
// precedence rule (configured entries first, in config file order; built-in table next; first
// substring match wins either way).
import { describe, expect, it } from "vitest";
import {
  BUILTIN_AUTO_FACADE_CLIENTS,
  FALLBACK_FACADE_MODE,
  resolveAutoFacadeMode,
} from "../src/mcp/facade-auto";

describe("resolveAutoFacadeMode (THE-1123)", () => {
  it("matches a built-in entry by case-insensitive substring", () => {
    expect(resolveAutoFacadeMode("Claude-Code-CLI/1.2")).toBe("domain");
  });

  it("is case-insensitive on both the observed name and the table key", () => {
    expect(resolveAutoFacadeMode("CLAUDE-CODE-DESKTOP")).toBe("domain");
  });

  it("falls back to the default for an unmatched client name", () => {
    expect(resolveAutoFacadeMode("some-random-mcp-client")).toBe(FALLBACK_FACADE_MODE);
    expect(FALLBACK_FACADE_MODE).toBe("triad");
  });

  it("falls back to the default when no clientInfo.name was observed", () => {
    expect(resolveAutoFacadeMode(undefined)).toBe(FALLBACK_FACADE_MODE);
  });

  it("a configured entry overrides the built-in table for the same substring", () => {
    expect(resolveAutoFacadeMode("claude-code-cli", { "claude-code": "flat" })).toBe("flat");
    // Sanity: the built-in table alone (no config) still says "domain" for the same name.
    expect(resolveAutoFacadeMode("claude-code-cli")).toBe("domain");
  });

  it("configured entries are tried in the CONFIG's key order — first match wins", () => {
    // "cursor-ide" matches both keys; "cursor" is declared first, so it wins over "cur" even
    // though object property order would otherwise be arbitrary if this weren't respected.
    expect(resolveAutoFacadeMode("cursor-ide", { cursor: "flat", cur: "domain" })).toBe("flat");
    // Reversed declaration order flips the winner — proves order is actually read, not name length
    // or any other implicit tiebreak.
    expect(resolveAutoFacadeMode("cursor-ide", { cur: "domain", cursor: "flat" })).toBe("domain");
  });

  it("a configured entry with no matching substring falls through to the built-in table", () => {
    expect(resolveAutoFacadeMode("cursor-nightly", { windsurf: "domain" })).toBe("triad");
  });

  it("the built-in table is checked in its own declared order and its first entry is claude-code -> domain", () => {
    expect(BUILTIN_AUTO_FACADE_CLIENTS[0]).toEqual(["claude-code", "domain"]);
  });
});
