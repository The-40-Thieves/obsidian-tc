// THE-658: the three gaps left after mint tooling landed and the AS decision was recorded.
//
// The ticket's headline replay path was measured LIVE on this deployment: with a shared HS256
// secret and no `aud`, a token minted for any service sharing that secret is accepted here. That
// was closed by configuration; this closes it by construction, so a future deployment cannot
// re-open it by omitting one config key.
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { wwwAuthenticateChallenge } from "../src/auth/protected-resource";

const vaults = [{ id: "v1", path: "/tmp/v1" }];
const parse = (auth: Record<string, unknown>) => ServerConfigSchema.safeParse({ vaults, auth });

describe("audience binding is a GATE, not a warning", () => {
  it("REFUSES auth.mode 'jwt' with no audience and no resource", () => {
    // Previously this parsed fine and only warned, and only when a JWKS was configured — so the
    // common HS256 deployment got nothing at all.
    const r = parse({ mode: "jwt", jwtSecret: "s".repeat(40) });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(JSON.stringify(r.error.issues)).toMatch(/audience/);
    }
  });

  it("accepts an explicit audience", () => {
    expect(parse({ mode: "jwt", jwtSecret: "s".repeat(40), audience: "http://x" }).success).toBe(
      true,
    );
  });

  it("accepts `resource` alone, since the transport defaults the audience to it", () => {
    expect(parse({ mode: "jwt", jwtSecret: "s".repeat(40), resource: "http://x" }).success).toBe(
      true,
    );
  });

  it("leaves mode 'none' alone — there is no token to bind", () => {
    expect(parse({ mode: "none" }).success).toBe(true);
  });
});

describe("jwksUri — a key source that can rotate", () => {
  it("satisfies the jwt key-source requirement on its own", () => {
    // Without this, `mode: "jwt"` demanded a secret or a static document, so an AS-backed
    // deployment could not be expressed at all.
    const r = parse({
      mode: "jwt",
      jwksUri: "https://as.example/.well-known/jwks.json",
      audience: "http://x",
    });
    expect(r.success).toBe(true);
  });

  it("rejects a non-URL", () => {
    expect(parse({ mode: "jwt", jwksUri: "not-a-url", audience: "http://x" }).success).toBe(false);
  });

  it("still refuses jwt with no key source at all", () => {
    expect(parse({ mode: "jwt", audience: "http://x" }).success).toBe(false);
  });
});

describe("WWW-Authenticate carries `scope` (SEP: 2026-07-28 SHOULD)", () => {
  const base = {
    mode: "jwt" as const,
    jwtSecret: "s".repeat(40),
    resource: "https://mcp.example.com",
    authorizationServers: ["https://as.example.com"],
  };

  it("emits scope when scopesSupported is configured", () => {
    // A general-purpose MCP client has no domain knowledge to pick scopes with; its documented
    // fallback when `scope` is absent is to request EVERY scope in scopes_supported. Omitting the
    // parameter therefore does not fail closed — it pushes clients to over-ask.
    const c = ServerConfigSchema.parse({
      vaults,
      auth: { ...base, scopesSupported: ["read:notes", "write:notes"] },
    });
    const challenge = wwwAuthenticateChallenge(c.auth);
    expect(challenge).toContain('scope="read:notes write:notes"');
    expect(challenge).toContain("resource_metadata=");
  });

  it("omits scope entirely when none are configured, rather than emitting an empty one", () => {
    const c = ServerConfigSchema.parse({ vaults, auth: base });
    expect(wwwAuthenticateChallenge(c.auth)).not.toContain("scope=");
  });
});
