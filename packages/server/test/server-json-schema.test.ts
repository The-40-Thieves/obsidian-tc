// server.json is the MCP Registry manifest. The registry validates it against the JSON Schema named
// in its own `$schema` field; a drift fails at publish time, after the tag is pushed. This test
// validates the committed server.json against a vendored copy of that schema.
//
// The vendored schema (test/fixtures/mcp-registry-server.schema.json) is the file served at
// https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json, fetched
// 2026-10-10. That is the schema every example in the registry's own docs
// (modelcontextprotocol.io/registry/package-types, /versioning) names today. When the registry
// ships a newer one, bump `$schema` in server.json, replace the fixture from the same URL, and this
// test pins the pair together.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const serverJson = JSON.parse(read("../../../server.json"));
const schema = JSON.parse(read("./fixtures/mcp-registry-server.schema.json"));
const validate = new AjvJsonSchemaValidator().getValidator(schema);
const pkgVersion = JSON.parse(read("../package.json")).version as string;

describe("server.json against the registry schema", () => {
  it("names the vendored schema as its $schema", () => {
    expect(serverJson.$schema).toBe(schema.$id);
  });

  it("validates", () => {
    const r = validate(serverJson) as { valid: boolean; errorMessage?: string };
    expect(r.errorMessage).toBeUndefined();
    expect(r.valid).toBe(true);
  });

  it("carries the current package version on the server and on its npm package entry", () => {
    expect(serverJson.version).toBe(pkgVersion);
    const npm = serverJson.packages.find((p: { registryType: string }) => p.registryType === "npm");
    expect(npm.version).toBe(pkgVersion);
    expect(npm.identifier).toBe("obsidian-tc");
    expect(npm.transport).toEqual({ type: "stdio" });
  });

  it("the validator is live: it rejects a manifest missing required fields", () => {
    const r = validate({ name: "x" }) as { valid: boolean; errorMessage?: string };
    expect(r.valid).toBe(false);
    expect(r.errorMessage).toMatch(/description/);
  });
});
