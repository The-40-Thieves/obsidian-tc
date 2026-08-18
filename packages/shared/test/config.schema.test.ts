import { describe, expect, it } from "vitest";
import {
  EmbeddingsConfigSchema,
  ExperientialConfigSchema,
  ObsidianTcError,
  PersonaConfigSchema,
  PersonasConfigSchema,
  ServerConfigSchema,
} from "../src/index";

const base = { vaults: [{ id: "main", path: "/v" }] };

describe("ServerConfigSchema", () => {
  it("accepts a minimal config and applies transport/auth defaults", () => {
    const c = ServerConfigSchema.parse(base);
    expect(c.auth.mode).toBe("none");
    expect(c.transports.http.enabled).toBe(false);
    expect(c.transports.http.host).toBe("127.0.0.1");
  });

  // F8: "oauth" was accepted at config load but returned 501 at request time; it is
  // no longer a valid auth mode (rejected at load).
  it("rejects auth.mode 'oauth' (F8)", () => {
    expect(ServerConfigSchema.safeParse({ ...base, auth: { mode: "oauth" } }).success).toBe(false);
  });

  // F2: never run an unauthenticated server on a routable host.
  it("rejects HTTP on a non-loopback host with auth.mode 'none' (F2)", () => {
    const r = ServerConfigSchema.safeParse({
      ...base,
      auth: { mode: "none" },
      transports: { http: { enabled: true, host: "0.0.0.0" } },
    });
    expect(r.success).toBe(false);
  });

  it("allows unauthenticated HTTP on a loopback host (F2)", () => {
    const r = ServerConfigSchema.safeParse({
      ...base,
      auth: { mode: "none" },
      transports: { http: { enabled: true, host: "127.0.0.1" } },
    });
    expect(r.success).toBe(true);
  });

  // THE-456 (audit #3): a remote (non-loopback) jwt bind must ALSO bind the token audience — a bare
  // HS256 secret with no audience is now refused off loopback (audience-optional HS256 is loopback-only).
  it("allows non-loopback HTTP jwt when an audience is bound (F2 / THE-456)", () => {
    const r = ServerConfigSchema.safeParse({
      ...base,
      auth: { mode: "jwt", jwtSecret: "x".repeat(32), audience: "https://mcp.example.com" },
      transports: { http: { enabled: true, host: "0.0.0.0" } },
    });
    expect(r.success).toBe(true);
  });

  it("rejects non-loopback HTTP jwt with no audience/resource (THE-456)", () => {
    const r = ServerConfigSchema.safeParse({
      ...base,
      auth: { mode: "jwt", jwtSecret: "x".repeat(32) },
      transports: { http: { enabled: true, host: "0.0.0.0" } },
    });
    expect(r.success).toBe(false);
  });

  it("keeps audience-optional HS256 on a loopback bind (THE-456)", () => {
    const r = ServerConfigSchema.safeParse({
      ...base,
      auth: { mode: "jwt", jwtSecret: "x".repeat(32) },
      transports: { http: { enabled: true, host: "127.0.0.1" } },
    });
    expect(r.success).toBe(true);
  });

  it("rejects a JWKS config with no audience/resource, even on loopback (THE-456)", () => {
    const r = ServerConfigSchema.safeParse({
      ...base,
      auth: { mode: "jwt", jwks: { keys: [] } },
      transports: { http: { enabled: true, host: "127.0.0.1" } },
    });
    expect(r.success).toBe(false);
  });

  it("allows a JWKS config when an audience is bound (THE-456)", () => {
    const r = ServerConfigSchema.safeParse({
      ...base,
      auth: { mode: "jwt", jwks: { keys: [] }, audience: "https://mcp.example.com" },
      transports: { http: { enabled: true, host: "127.0.0.1" } },
    });
    expect(r.success).toBe(true);
  });

  it("rejects an issuer with no bound audience — partial binding (THE-456)", () => {
    // Setting issuer (tokens from an external AS) without an audience validates only half the claim.
    const issuerOnly = {
      ...base,
      auth: { mode: "jwt" as const, jwtSecret: "x".repeat(32), issuer: "https://as.example.com" },
      transports: { http: { enabled: true, host: "127.0.0.1" } },
    };
    expect(ServerConfigSchema.safeParse(issuerOnly).success).toBe(false);
    // Bind an audience (here via the PRM resource) -> both halves validated -> accepted.
    expect(
      ServerConfigSchema.safeParse({
        ...issuerOnly,
        auth: { ...issuerOnly.auth, resource: "https://mcp.example.com" },
      }).success,
    ).toBe(true);
  });

  it("still serves a PRM resource without a local issuer check (THE-456)", () => {
    // A PRM config advertises authorization servers for discovery; the resource doubles as the bound
    // audience. It does not, by itself, force a local issuer claim, so this stays valid.
    const r = ServerConfigSchema.safeParse({
      ...base,
      auth: {
        mode: "jwt",
        jwtSecret: "x".repeat(32),
        resource: "https://mcp.example.com",
        authorizationServers: ["https://as.example.com"],
      },
      transports: { http: { enabled: true, host: "127.0.0.1" } },
    });
    expect(r.success).toBe(true);
  });

  // F2 (review hardening): a malformed 127.x.x.x address has invalid octets and is
  // NOT loopback, so an unauthenticated bind to it must still be refused.
  it("rejects a malformed 127.x host with auth.mode 'none' (F2)", () => {
    const r = ServerConfigSchema.safeParse({
      ...base,
      auth: { mode: "none" },
      transports: { http: { enabled: true, host: "127.999.999.999" } },
    });
    expect(r.success).toBe(false);
  });

  // F2 (review hardening): bracketed IPv6 loopback normalizes to ::1 and is allowed.
  it("allows unauthenticated HTTP on a bracketed IPv6 loopback host (F2)", () => {
    const r = ServerConfigSchema.safeParse({
      ...base,
      auth: { mode: "none" },
      transports: { http: { enabled: true, host: "[::1]" } },
    });
    expect(r.success).toBe(true);
  });
});

// THE-647 item 2.
describe("PersonasConfigSchema", () => {
  it("is absent by default (backward compatible — no personas configured)", () => {
    const c = ServerConfigSchema.parse(base);
    expect(c.personas).toBeUndefined();
  });

  it("accepts a config with two or more named personas", () => {
    const c = ServerConfigSchema.parse({
      ...base,
      personas: {
        researcher: { vaults: ["main"], scopes: ["read:notes"] },
        author: { vaults: ["main"], scopes: ["read:notes", "write:notes"] },
      },
    });
    expect(Object.keys(c.personas ?? {})).toEqual(["researcher", "author"]);
    expect(c.personas?.researcher?.scopes).toEqual(["read:notes"]);
  });

  it("rejects a persona with an empty vaults or scopes list", () => {
    expect(
      PersonasConfigSchema.safeParse({ p: { vaults: [], scopes: ["read:notes"] } }).success,
    ).toBe(false);
    expect(PersonasConfigSchema.safeParse({ p: { vaults: ["main"], scopes: [] } }).success).toBe(
      false,
    );
  });

  it("accepts an optional per-persona toolVisibility override", () => {
    const r = PersonaConfigSchema.safeParse({
      vaults: ["main"],
      scopes: ["read:notes"],
      toolVisibility: { hidden: ["reflect"] },
    });
    expect(r.success).toBe(true);
  });
});

describe("ExperientialConfigSchema.activationRerank (THE-424 Part A)", () => {
  // This assertion has now been inverted once, deliberately, and the history is the point.
  //
  // THE-535 found the describe string claiming the flag "applies the ACT-R activation bubble pass"
  // when it did not — the pass needs BOTH activationFor AND opts.bubbleSafe.enabled, and nothing
  // under src/ set the latter. The fix then was to make the DESCRIPTION honest ("not yet wired"),
  // and this test pinned that.
  //
  // THE-424 Part A made the CODE honest instead: the M7 options builder now sets bubbleSafe under
  // this same flag, so the original claim is true and the "not yet wired" hedge became the lie.
  // What is really being pinned across both versions is one invariant — the description and the
  // behaviour agree — so the test moves whenever the behaviour does, and an edit that reintroduces
  // a stale hedge is caught exactly like an overclaim was.
  it("describes the flag as applying a ranking change, with no stale not-wired hedge", () => {
    const desc = ExperientialConfigSchema.shape.activationRerank.description ?? "";
    expect(desc).toMatch(/bubble pass/i);
    expect(desc).toMatch(/ranking|order/i);
    expect(desc).not.toMatch(/not.{0,20}wired/i);
  });

  it("still defaults to false — Part A wires the lever, Part B decides where it rests", () => {
    const parsed = ExperientialConfigSchema.parse({});
    expect(parsed.activationRerank).toBe(false);
  });
});

// THE-591: closes the same "built and dark" gap THE-535 (above) documents for
// experiential.activationRerank — retrieval.gatedRerank and indexing.streamingWalk existed as
// fully-implemented, fully-tested code paths with NO config key at all, reachable only from the
// eval harness / direct indexVault callers in tests. These pin the schema half of the fix: the
// key exists, parses off a minimal config, and defaults false (neither capability is proven to
// win/safe-by-default yet — see the server-side wiring tests for the consumer half of the proof).
describe("retrieval.gatedRerank / indexing.streamingWalk (THE-591)", () => {
  it("both default to false on a minimal config", () => {
    const c = ServerConfigSchema.parse(base);
    expect(c.retrieval.gatedRerank).toBe(false);
    expect(c.indexing.streamingWalk).toBe(false);
  });

  it("both are settable to true and round-trip through ServerConfigSchema", () => {
    const c = ServerConfigSchema.parse({
      ...base,
      retrieval: { gatedRerank: true },
      indexing: { streamingWalk: true },
    });
    expect(c.retrieval.gatedRerank).toBe(true);
    expect(c.indexing.streamingWalk).toBe(true);
  });
});

// Task 2 follow-up (pluggable-provider-slots): the commit that opened `embeddings.provider`
// from `z.enum([...six...])` to `z.string().min(1)` shipped with no test that ever called
// EmbeddingsConfigSchema.parse() — its own new test file only exercises createEmbeddingProvider,
// which never touches this schema. These pin the actual Zod boundary that changed: a config file
// naming a non-legacy provider (e.g. a future registry entry like "openai-compatible") must not
// fail validation the way the old closed enum would have rejected it, the original six names must
// still parse, `provider` must still default to "ollama", and `.min(1)` must still reject empty.
describe("EmbeddingsConfigSchema.provider (Task 2 follow-up)", () => {
  it("accepts a non-legacy provider name that the old z.enum would have rejected", () => {
    const parsed = EmbeddingsConfigSchema.parse({
      provider: "openai-compatible",
      model: "m",
      dimensions: 3,
    });
    expect(parsed.provider).toBe("openai-compatible");
  });

  it("still accepts every original enum name", () => {
    for (const provider of ["ollama", "openai", "voyage", "cohere", "bge-m3", "model-tier"]) {
      const parsed = EmbeddingsConfigSchema.parse({ provider, model: "m", dimensions: 3 });
      expect(parsed.provider).toBe(provider);
    }
  });

  it("defaults provider to 'ollama' when omitted", () => {
    const parsed = EmbeddingsConfigSchema.parse({});
    expect(parsed.provider).toBe("ollama");
  });

  it("still rejects an empty-string provider (.min(1) survived the enum -> string change)", () => {
    const r = EmbeddingsConfigSchema.safeParse({ provider: "", model: "m", dimensions: 3 });
    expect(r.success).toBe(false);
  });
});

describe("ObsidianTcError", () => {
  it("marks throttled retryable and forbidden non-retryable", () => {
    expect(new ObsidianTcError("throttled", "x").retryable).toBe(true);
    expect(new ObsidianTcError("forbidden", "x").retryable).toBe(false);
  });

  it("serializes to a structured ErrorJSON with details", () => {
    const j = new ObsidianTcError("acl_denied", "denied", { path: "/x" }).toJSON();
    expect(j).toMatchObject({ code: "acl_denied", retryable: false, details: { path: "/x" } });
  });
});
