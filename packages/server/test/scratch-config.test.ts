import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";

// THE-624: contributors had no committed scratch vault to point a local server at, so
// CONTRIBUTING.md's "do not use your real vault" advice had nothing to copy. This asserts the
// committed pairing — examples/config.scratch.json + examples/scratch-vault/ — stays valid and
// stays a pair: a config referencing a fixture directory that has quietly stopped existing (or
// vice versa) would be exactly as useless as having neither.
describe("scratch example config", () => {
  it("examples/config.scratch.json is schema-valid and points at the committed scratch vault", () => {
    const configPath = fileURLToPath(
      new URL("../../../examples/config.scratch.json", import.meta.url),
    );
    const parsed = ServerConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8")));

    expect(parsed.vaults).toHaveLength(1);
    // A placeholder prefix, like config.hardened.json's — a contributor substitutes their own
    // clone's absolute path. Only the suffix is a contract this repo can hold itself to.
    expect(parsed.vaults[0]?.path.endsWith("examples/scratch-vault")).toBe(true);

    const vaultDir = join(dirname(configPath), "scratch-vault");
    expect(existsSync(vaultDir)).toBe(true);
    expect(existsSync(join(vaultDir, "00-example"))).toBe(true);
  });
});
