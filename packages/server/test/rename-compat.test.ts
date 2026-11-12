// 2.0 renamed obsidian-tc to reliquary-tc. Each wire-level identifier a client already uses keeps
// working under its old spelling; these tests pin that for every server surface that reads one.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LEGACY_NAMES } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { ADVISORY_SUBSCRIPTION_KEY, requestedAdvisoryKey } from "../src/mcp/advisories";
import {
  buildResourceUri,
  CATALOG_RESOURCE_URI,
  isCatalogResourceUri,
  parseResourceUri,
} from "../src/mcp/resources";
import { extractClaimedProvenance, PROVENANCE_META_KEY } from "../src/provenance/types";

describe("rename compatibility (server surfaces)", () => {
  it("builds new-scheme URIs and parses both schemes to the same note", () => {
    const uri = buildResourceUri("main", "a b/c.md");
    expect(uri.startsWith("reliquary-tc://")).toBe(true);
    const legacy = `${LEGACY_NAMES.resourceScheme}://main/a%20b/c.md`;
    expect(parseResourceUri(legacy)).toEqual(parseResourceUri(uri));
    expect(() => parseResourceUri("file:///etc/passwd")).toThrow(/unsupported resource URI scheme/);
  });

  it("recognises the catalog resource under either scheme", () => {
    expect(CATALOG_RESOURCE_URI).toBe("reliquary-tc://catalog");
    expect(isCatalogResourceUri("reliquary-tc://catalog")).toBe(true);
    expect(isCatalogResourceUri(`${LEGACY_NAMES.resourceScheme}://catalog`)).toBe(true);
    expect(isCatalogResourceUri("reliquary-tc://main/catalog")).toBe(false);
  });

  it("accepts the advisory subscription under either key and echoes the one used", () => {
    const sub = (key: string) => ({ params: { notifications: { [key]: true } } });
    expect(requestedAdvisoryKey(sub(ADVISORY_SUBSCRIPTION_KEY))).toBe(ADVISORY_SUBSCRIPTION_KEY);
    expect(requestedAdvisoryKey(sub(LEGACY_NAMES.advisorySubscriptionKey))).toBe(
      LEGACY_NAMES.advisorySubscriptionKey,
    );
    expect(requestedAdvisoryKey(sub("io.example/other"))).toBeUndefined();
  });

  it("reads self-reported provenance from the current or the legacy _meta key", () => {
    expect(PROVENANCE_META_KEY).toBe("io.reliquary-tc/provenance");
    const claim = { model: "m1" };
    expect(extractClaimedProvenance({ [PROVENANCE_META_KEY]: claim })?.model).toBe("m1");
    expect(extractClaimedProvenance({ [LEGACY_NAMES.provenanceMetaKey]: claim })?.model).toBe("m1");
  });

  it("keeps the env-alias install as cli.ts's first import", () => {
    const src = readFileSync(join(__dirname, "..", "src", "cli.ts"), "utf8");
    const firstImport = src.split("\n").find((line) => line.startsWith("import "));
    expect(firstImport).toBe('import "./legacy-env-install";');
  });
});
