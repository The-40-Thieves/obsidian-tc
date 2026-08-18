// THE-647 item 2: persona resolution. A JWT `persona` claim resolves ONLY against the server's
// configured `personas` map — never a union with the token's own (wider) scopes/vault, and never
// a silent fallback on an unrecognised name.
import { PersonasConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { resolvePersona } from "../src/auth/persona";

// Parsed through the real schema (not a hand-typed literal) so this fixture exercises exactly
// the shape the loaded config produces, defaults included — same precedent as visibility.test.ts.
const personas = PersonasConfigSchema.parse({
  researcher: { vaults: ["main"], scopes: ["read:notes"] },
  author: {
    vaults: ["main", "scratch"],
    scopes: ["read:notes", "write:notes"],
    toolVisibility: { hidden: ["knowledge_challenge"] },
  },
});

describe("resolvePersona (THE-647 item 2)", () => {
  it("resolves exactly the named persona's scopes and default (first) vault", () => {
    const r = resolvePersona("researcher", undefined, personas);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolution.vaultId).toBe("main");
      expect([...r.resolution.scopes]).toEqual(["read:notes"]);
      expect(r.resolution.persona).toBe("researcher");
      expect(r.resolution.toolVisibility).toBeUndefined();
    }
  });

  it("carries a persona's own toolVisibility override through", () => {
    const r = resolvePersona("author", "scratch", personas);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolution.vaultId).toBe("scratch");
      expect(r.resolution.toolVisibility?.hidden).toEqual(["knowledge_challenge"]);
    }
  });

  it("a token's requested vault must be one of the persona's — never widened", () => {
    const r = resolvePersona("researcher", "scratch", personas);
    expect(r).toEqual({ ok: false, reason: "vault_not_in_persona" });
  });

  it("an unknown persona name fails closed rather than falling back to the token's own grant", () => {
    const r = resolvePersona("ghost", undefined, personas);
    expect(r).toEqual({ ok: false, reason: "unknown_persona" });
  });

  it("fails closed when personas is not configured at all", () => {
    const r = resolvePersona("researcher", undefined, undefined);
    expect(r).toEqual({ ok: false, reason: "unknown_persona" });
  });

  it("never unions the persona's scopes with anything else the caller might have asked for", () => {
    // resolvePersona's signature does not even accept the token's own scopes — this test pins
    // that the returned set is EXACTLY the persona's, by construction, not by convention.
    const r = resolvePersona("researcher", undefined, personas);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolution.scopes.size).toBe(1);
  });
});
