// FIVE refusals, all at boot. Every `rejects` is awaited: in Vitest 4 an un-awaited one PASSES
// even when the code is wrong, and these guard a security boundary.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadProviderModule } from "../src/providers/module-loader";

function fixture(contents: string): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "otc-provider-"));
  writeFileSync(join(dir, "provider.mjs"), contents, "utf8");
  return { dir, file: "provider.mjs" };
}

const GOOD = `export function createEmbeddingProvider() {
  return { id: "m:x", provider: "module", model: "x", dimensions: 3, embed: async (t) => t.map(() => [0,0,0]) };
}`;
const base = { exportName: "createEmbeddingProvider" as const, slot: "embeddings" as const };

describe("module provider gate", () => {
  it("refuses under the hardened security profile", async () => {
    const { dir, file } = fixture(GOOD);
    await expect(
      loadProviderModule({
        ...base,
        modulePath: file,
        configDir: dir,
        securityProfile: "hardened",
      }),
    ).rejects.toThrow(/hardened/);
  });

  it("refuses a relative path with no config directory", async () => {
    await expect(
      loadProviderModule({
        ...base,
        modulePath: "./p.mjs",
        configDir: undefined,
        securityProfile: "trusted-local",
      }),
    ).rejects.toThrow(/config/i);
  });

  it("refuses a module missing the expected export", async () => {
    const { dir, file } = fixture(`export const nope = 1;`);
    await expect(
      loadProviderModule({
        ...base,
        modulePath: file,
        configDir: dir,
        securityProfile: "trusted-local",
      }),
    ).rejects.toThrow(/createEmbeddingProvider/);
  });

  it("refuses a malformed provider BEFORE it is used", async () => {
    const { dir, file } = fixture(
      `export function createEmbeddingProvider() { return { id: "x", dimensions: -1 }; }`,
    );
    await expect(
      loadProviderModule({
        ...base,
        modulePath: file,
        configDir: dir,
        securityProfile: "trusted-local",
      }),
    ).rejects.toThrow(/embed|dimensions/);
  });

  it("refuses when modulePath is absent entirely", async () => {
    // A bare /modulePath/ regex also matches the unrelated "could not be imported" message from
    // the resolve-and-import step further down (resolve(configDir, "") collapses to configDir,
    // which then fails to import as a directory) — that collision would let this test pass even
    // with the guard removed. Anchor on the guard's own "not set" wording so the mutation sweep
    // (see task-8-report.md) actually discriminates this refusal from that one.
    await expect(
      loadProviderModule({
        ...base,
        modulePath: "",
        configDir: "/tmp",
        securityProfile: "trusted-local",
      }),
    ).rejects.toThrow(/modulePath is not set/);
  });

  it("loads a well-formed module under trusted-local", async () => {
    const { dir, file } = fixture(GOOD);
    const p = await loadProviderModule<{ dimensions: number }>({
      ...base,
      modulePath: file,
      configDir: dir,
      securityProfile: "trusted-local",
    });
    expect(p.dimensions).toBe(3);
  });

  it("refuses a module provider on the SYNC path (CLI/eval callers)", async () => {
    const { createEmbeddingProvider } = await import("../src/embeddings");
    expect(() =>
      createEmbeddingProvider({
        provider: "module",
        model: "x",
        dimensions: 3,
        modulePath: "./p.mjs",
      }),
    ).toThrow(/boot|code path/i);
  });
});
