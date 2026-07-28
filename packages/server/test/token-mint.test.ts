// THE-658 step 2: mint tooling, and specifically its two refusals.
//
// Both refusals encode a failure this deployment has already paid for, so they are asserted on the
// MESSAGE as well as the throw — a refusal that does not say which knob to turn just moves the
// confusion somewhere else.
//
// `planMint` is pure and takes `now`, so every case below runs with no filesystem, no clock and no
// signing key. Only the two end-to-end tests touch jose, to prove the plan is actually what gets
// signed — a planner that agrees with itself and disagrees with the token is the failure mode that
// would make all the rest of this vacuous.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { planMint, readAuthBlock, type TokenMintCmd } from "../src/cli/commands/token-mint";

const NOW = 1_800_000_000;
const SECRET = "test-only-secret-not-a-real-credential-0123456789";

const jwtAuth = (extra: Record<string, unknown> = {}) => ({
  mode: "jwt",
  jwtSecret: SECRET,
  ...extra,
});
const cmd = (over: Partial<TokenMintCmd> = {}): TokenMintCmd => ({
  kind: "token-mint",
  sub: "cave-agents",
  ...over,
});

describe("planMint — refusals", () => {
  it("refuses without --sub, because an unattributable token is the thing to avoid", () => {
    expect(() => planMint(jwtAuth(), { kind: "token-mint" }, NOW)).toThrow(/--sub/);
  });

  it("refuses when the config is not in jwt mode — the token would never be verified", () => {
    expect(() => planMint({ mode: "none" }, cmd(), NOW)).toThrow(/not "jwt"/);
  });

  it("refuses when jwt mode has no secret to sign with", () => {
    expect(() => planMint({ mode: "jwt" }, cmd(), NOW)).toThrow(/no auth.jwtSecret/);
  });

  it("refuses an aud-less mint when the config BINDS an audience (the THE-456 trap)", () => {
    // jwt.ts passes `audience` to jose only when configured, and jose then rejects any token with
    // no aud claim. Minting one anyway produces a credential refused on first use with
    // missing_claim — which is exactly how the live tokens came to be aud-less.
    expect(() =>
      planMint(jwtAuth({ audience: "http://obsidian-tc:8765" }), cmd({ aud: "" }), NOW),
    ).toThrow(/missing_claim/);
  });

  it("refuses a --ttl above auth.tokenTtlSeconds, naming the AGE-vs-remaining-life distinction", () => {
    // The five-day outage: tokenTtlSeconds caps a token's AGE, so a year-long exp under a 24h cap
    // dies after a day while still LOOKING valid for a year.
    expect(() =>
      planMint(jwtAuth({ tokenTtlSeconds: 86_400 }), cmd({ ttl: 31_536_000 }), NOW),
    ).toThrow(/caps token AGE, not remaining life/);
  });

  it("refuses a non-positive --ttl", () => {
    expect(() => planMint(jwtAuth(), cmd({ ttl: 0 }), NOW)).toThrow(/positive/);
  });
});

describe("planMint — what it produces", () => {
  it("inherits the configured audience rather than making the operator repeat it", () => {
    const { claims } = planMint(jwtAuth({ audience: "http://obsidian-tc:8765" }), cmd(), NOW);
    expect(claims.aud).toBe("http://obsidian-tc:8765");
  });

  it("falls back to auth.resource, because createHttpApp defaults the audience to it", () => {
    // THE-456: with PRM configured and no explicit audience, the verifier binds to `resource`. A
    // token minted from such a config must match that, or it is refused by a server whose config
    // never mentions `audience` at all.
    const { claims } = planMint(jwtAuth({ resource: "https://mcp.example.com" }), cmd(), NOW);
    expect(claims.aud).toBe("https://mcp.example.com");
  });

  it("lets an explicit --aud win over the config", () => {
    const { claims } = planMint(jwtAuth({ audience: "http://a" }), cmd({ aud: "http://b" }), NOW);
    expect(claims.aud).toBe("http://b");
  });

  it("omits aud entirely when nothing binds one — loopback HS256 stays legal", () => {
    const { claims } = planMint(jwtAuth(), cmd(), NOW);
    expect(claims).not.toHaveProperty("aud");
  });

  it("defaults the ttl to the cap: the longest life the verifier will honour", () => {
    const { ttlSeconds, claims } = planMint(jwtAuth({ tokenTtlSeconds: 3600 }), cmd(), NOW);
    expect(ttlSeconds).toBe(3600);
    expect(claims.exp).toBe(NOW + 3600);
    expect(claims.iat).toBe(NOW);
  });

  it("treats an empty --scopes as NO scopes, not as absent", () => {
    // A /metrics scraper legitimately needs none; only an absent flag means "everything". Getting
    // this backwards would silently hand a scrape credential full vault access.
    expect(planMint(jwtAuth(), cmd({ scopes: "" }), NOW).claims.scopes).toEqual([]);
    expect(planMint(jwtAuth(), cmd(), NOW).claims.scopes).toEqual(["*"]);
    expect(planMint(jwtAuth(), cmd({ scopes: "read:notes, search" }), NOW).claims.scopes).toEqual([
      "read:notes",
      "search",
    ]);
  });

  it("only sets `vault` when asked — an unbound token is the multi-vault default", () => {
    expect(planMint(jwtAuth(), cmd(), NOW).claims).not.toHaveProperty("vault");
    expect(planMint(jwtAuth(), cmd({ vault: "main" }), NOW).claims.vault).toBe("main");
  });
});

describe("readAuthBlock", () => {
  const write = (body: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "tc-mint-"));
    const p = join(dir, "config.json");
    writeFileSync(p, body, "utf8");
    return p;
  };

  it("reads the auth block out of a config file", () => {
    const p = write(JSON.stringify({ vaults: [], auth: { mode: "jwt", jwtSecret: "s" } }));
    expect(readAuthBlock(p)).toEqual({ mode: "jwt", jwtSecret: "s" });
  });

  it("returns an empty block when auth is absent, rather than throwing", () => {
    // planMint then refuses with "not jwt", which names the actual problem. Throwing here would
    // report a parse failure for a config that parses perfectly well.
    expect(readAuthBlock(write(JSON.stringify({ vaults: [] })))).toEqual({});
  });

  it("reports a missing file and invalid JSON distinctly", () => {
    expect(() => readAuthBlock(join(tmpdir(), "tc-mint-nope-658", "config.json"))).toThrow(
      /cannot read config/,
    );
    expect(() => readAuthBlock(write("{not json"))).toThrow(/not valid JSON/);
  });
});

describe("the planned claims are what actually gets signed", () => {
  // The planner agreeing with itself proves nothing if the signer disagrees with it.
  it("produces a token jose verifies under the same secret, audience and max age", async () => {
    const auth = jwtAuth({ audience: "http://obsidian-tc:8765", tokenTtlSeconds: 3600 });
    const { claims } = planMint(auth, cmd({ vault: "main", scopes: "read:notes" }), NOW);
    const { SignJWT } = await import("jose");
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .sign(new TextEncoder().encode(SECRET));

    const { payload } = await jwtVerify(token, new TextEncoder().encode(SECRET), {
      audience: "http://obsidian-tc:8765",
    });
    expect(payload.sub).toBe("cave-agents");
    expect(payload.vault).toBe("main");
    expect(payload.scopes).toEqual(["read:notes"]);
  });

  it("produces a token the verifier REJECTS under a different audience", async () => {
    // The whole point of binding: a token minted for this resource must not be replayable against
    // another service sharing the secret.
    const { claims } = planMint(jwtAuth({ audience: "http://obsidian-tc:8765" }), cmd(), NOW);
    const { SignJWT } = await import("jose");
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .sign(new TextEncoder().encode(SECRET));

    await expect(
      jwtVerify(token, new TextEncoder().encode(SECRET), { audience: "http://someone-else" }),
    ).rejects.toThrow();
  });
});
