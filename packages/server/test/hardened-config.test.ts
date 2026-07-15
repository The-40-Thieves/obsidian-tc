import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";

// Audit #268 P1 (safer deployment profile): the committed hardened example must stay schema-valid and
// fully threaded, so operators can copy one maintained least-privilege config.
describe("hardened example config", () => {
  it("examples/config.hardened.json is schema-valid and least-privilege", () => {
    const path = fileURLToPath(new URL("../../../examples/config.hardened.json", import.meta.url));
    const parsed = ServerConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    // the least-privilege knobs the audit asked operators to be able to copy in one file
    expect(parsed.acl.strictReadDefault).toBe(true);
    expect(parsed.writes.requireCas).toBe(true);
    expect(parsed.snapshots.enabled).toBe(true);
    expect(parsed.acl.deletePaths).toEqual([]);
    expect(parsed.acl.readPaths?.length ?? 0).toBeGreaterThan(0);
    expect(parsed.acl.writePaths?.length ?? 0).toBeGreaterThan(0);
  });
});
