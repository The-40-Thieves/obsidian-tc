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
import { afterAll, describe, expect, it } from "vitest";
import { planMint, readAuthBlock, type TokenMintCmd } from "../src/cli/commands/token-mint";

import { rmTemp } from "./tmp";

// THE-685: every mkdtempSync here was previously never removed — measured leaking on Linux and
// accumulating unbounded in %TEMP% on Windows, which never reaps it. Route them through one tracked
// helper and remove best-effort in afterEach: a cleanup that THROWS would fail the suite in
// teardown with every assertion passing, the exact shape PR #627 exists to remove.
const tmpDirs: string[] = [];
const tmpDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};
// afterAll, not afterEach: a fixture created at DESCRIBE scope (maintenance-traces does this) is
// built once for the whole block, and an afterEach would delete it out from under the second test
// in that block. afterAll is correct whatever the scope; the dirs simply live until the file ends.
afterAll(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmTemp(d);
    } catch {
      // Best-effort: a leaked dir is cheaper than a teardown failure.
    }
  }
});

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
    const dir = tmpDir("tc-mint-");
    const p = join(dir, "config.json");
    writeFileSync(p, body, "utf8");
    return p;
  };

  // Every case here is about what the FILE contains, so each passes an explicit empty env. Letting
  // these default to `process.env` made them pass or fail based on the developer's shell: since
  // readAuthBlock started applying applyEnvOverlays, a host that exports OBSIDIAN_TC_JWT_SECRET
  // (sourcing a deployment .env is enough) injected a jwtSecret into both expectations below and
  // failed two tests that have nothing to do with the environment.
  it("reads the auth block out of a config file", () => {
    const p = write(JSON.stringify({ vaults: [], auth: { mode: "jwt", jwtSecret: "s" } }));
    expect(readAuthBlock(p, {})).toEqual({ mode: "jwt", jwtSecret: "s" });
  });

  it("returns an empty block when auth is absent, rather than throwing", () => {
    // planMint then refuses with "not jwt", which names the actual problem. Throwing here would
    // report a parse failure for a config that parses perfectly well.
    expect(readAuthBlock(write(JSON.stringify({ vaults: [] })), {})).toEqual({});
  });

  it("reports a missing file and invalid JSON distinctly", () => {
    expect(() => readAuthBlock(join(tmpdir(), "tc-mint-nope-658", "config.json"))).toThrow(
      /cannot read config/,
    );
    expect(() => readAuthBlock(write("{not json"))).toThrow(/not valid JSON/);
  });
});

describe("readAuthBlock — OBSIDIAN_TC_JWT_SECRET overlay (THE-658 mint-on-env-secret)", () => {
  // The deployment shape the project's own docs recommend — "prefer OBSIDIAN_TC_JWT_SECRET, keeps
  // it off disk" — previously could not mint at all, because readAuthBlock read the raw file and
  // skipped applyEnvOverlays, the only thing that injects the env secret into auth.jwtSecret.
  const write = (body: string): string => {
    const dir = tmpDir("tc-mint-env-");
    const p = join(dir, "config.json");
    writeFileSync(p, body, "utf8");
    return p;
  };

  it("mints from an env-supplied secret alone, when the file has none", () => {
    const p = write(JSON.stringify({ vaults: [], auth: { mode: "jwt" } }));
    const auth = readAuthBlock(p, { OBSIDIAN_TC_JWT_SECRET: SECRET });
    const { claims } = planMint(auth, cmd(), NOW);
    expect(claims.sub).toBe("cave-agents");
  });

  it("lets the env secret override a file-provided one — same precedence as applyEnvOverlays", () => {
    const p = write(
      JSON.stringify({ vaults: [], auth: { mode: "jwt", jwtSecret: "file-secret" } }),
    );
    const auth = readAuthBlock(p, { OBSIDIAN_TC_JWT_SECRET: "env-secret" });
    expect(auth.jwtSecret).toBe("env-secret");
  });

  it("falls back to the file secret when no env var is set", () => {
    const p = write(
      JSON.stringify({ vaults: [], auth: { mode: "jwt", jwtSecret: "file-secret" } }),
    );
    expect(readAuthBlock(p, {}).jwtSecret).toBe("file-secret");
  });

  it("does not let an EMPTY env var blank out a file secret", () => {
    // applyEnvOverlays guards on `if (envSecret)`, so only a TRUTHY value overwrites — "env always
    // wins" is the wrong mental model and would delete a working secret on a host that exports the
    // variable empty. Asserting the guard directly, because the overlay is now shared with the
    // loader and a change to it would silently change what `token mint` reads.
    const p = write(
      JSON.stringify({ vaults: [], auth: { mode: "jwt", jwtSecret: "file-secret" } }),
    );
    expect(readAuthBlock(p, { OBSIDIAN_TC_JWT_SECRET: "" }).jwtSecret).toBe("file-secret");
  });

  it("still refuses when neither file nor env supplies a secret, naming OBSIDIAN_TC_JWT_SECRET", () => {
    const p = write(JSON.stringify({ vaults: [], auth: { mode: "jwt" } }));
    const auth = readAuthBlock(p, {});
    expect(() => planMint(auth, cmd(), NOW)).toThrow(/OBSIDIAN_TC_JWT_SECRET/);
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
