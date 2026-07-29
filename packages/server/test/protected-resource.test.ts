import { type ServerConfig, ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { buildProtectedResourceMetadata, isPrmConfigured } from "../src/auth/protected-resource";

const AS = "https://as.example.com";
const RES = "https://mcp.example.com/mcp";

function authOf(input: unknown): ServerConfig["auth"] {
  return ServerConfigSchema.parse({ vaults: [{ id: "v1", path: "/tmp/v1" }], auth: input }).auth;
}

describe("THE-661 Protected Resource Metadata: authorization_servers requirement", () => {
  // The MCP authorization spec layers a stricter MUST on top of RFC 9728's bare optionality: "The
  // Protected Resource Metadata document returned by the MCP server MUST include the
  // authorization_servers field containing at least one authorization server." That sentence is
  // identical, word for word, in both the 2025-11-25 and 2026-07-28 dated specs (verified against
  // both spec pages) -- so a `resource`-only config is correctly NOT enough to serve a PRM: a
  // partial document (missing a MUST field) would be less spec-compliant than serving none.
  it("stays unconfigured when resource is set but authorizationServers is empty", () => {
    expect(isPrmConfigured(authOf({ mode: "none", resource: RES }))).toBe(false);
  });

  it("stays unconfigured when neither resource nor authorizationServers is set", () => {
    expect(isPrmConfigured(authOf({ mode: "none" }))).toBe(false);
  });

  it("is configured once both resource and at least one authorizationServers entry are set", () => {
    expect(
      isPrmConfigured(authOf({ mode: "none", resource: RES, authorizationServers: [AS] })),
    ).toBe(true);
  });

  it("always advertises bearer_methods_supported: ['header'] -- the token verifier never reads a body or query string", () => {
    const doc = buildProtectedResourceMetadata(
      authOf({ mode: "none", resource: RES, authorizationServers: [AS] }),
    );
    expect(doc.bearer_methods_supported).toEqual(["header"]);
  });
});
