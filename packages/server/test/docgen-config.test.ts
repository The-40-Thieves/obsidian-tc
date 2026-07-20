// docgen config extractor (THE-471): walks ServerConfigObject → flat ConfigDoc[] with path, type,
// default, optionality. Pins representative keys so a Zod-introspection regression is caught.
import { describe, expect, it } from "vitest";
import { extractConfig } from "../scripts/docgen/extract-config";

describe("extractConfig (THE-471)", () => {
  const docs = extractConfig();
  const byPath = new Map(docs.map((d) => [d.path, d]));

  it("extracts the whole config tree, sorted by path", () => {
    expect(docs.length).toBeGreaterThan(100);
    const paths = docs.map((d) => d.path);
    expect([...paths]).toEqual([...paths].sort((a, b) => a.localeCompare(b)));
  });

  it("captures scalar keys with type + default", () => {
    expect(byPath.get("cacheDir")).toMatchObject({ type: "string", default: ".obsidian-tc" });
    expect(byPath.get("retrieval.rrfK")).toMatchObject({ type: "number", default: 10 });
    expect(byPath.get("idempotencyTtlSeconds")).toMatchObject({ type: "number", default: 86400 });
    expect(byPath.get("writes.requireCas")).toMatchObject({ type: "boolean", default: false });
  });

  it("renders enum members in the type and captures their default", () => {
    expect(byPath.get("auth.mode")).toMatchObject({ type: "enum(none|jwt)", default: "none" });
    expect(byPath.get("embeddings.provider")?.type).toMatch(/^enum\(ollama\|/);
  });

  it("marks a defaulted key optional and a required key not optional", () => {
    expect(byPath.get("transports.http.enabled")).toMatchObject({
      type: "boolean",
      default: false,
      optional: true,
    });
    // vaults[].id has no default -> required
    expect(byPath.get("vaults[].id")).toMatchObject({ type: "string", optional: false });
  });

  it("recurses into array-of-object elements (vaults[]) and nested sections", () => {
    expect(byPath.has("vaults[].id")).toBe(true);
    expect(byPath.has("vaults[].path")).toBe(true);
    expect(byPath.has("transports.http.host")).toBe(true);
  });

  it("leaves an optional-without-default key with no default field", () => {
    const jwt = byPath.get("auth.jwtSecret");
    expect(jwt?.type).toBe("string");
    expect(jwt && "default" in jwt).toBe(false);
  });
});
