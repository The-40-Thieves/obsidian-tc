// FIVE refusals, all at boot. Every `rejects` is awaited: in Vitest 4 an un-awaited one PASSES
// even when the code is wrong, and these guard a security boundary.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProviderModule } from "../src/providers/module-loader";
import { rmTemp } from "./tmp";

// Every fixture dir is tracked and removed in afterEach. This suite is the worst case for the
// Windows teardown class this file's `rmTemp` exists for: each fixture writes a `.mjs` that
// `loadProviderModule` then **dynamically imports**, so the file stays mapped by the ESM loader and
// Windows refuses to DELETE it. Leaving these uncollected (as this suite originally did) leaks one
// directory per fixture call and seeds exactly the undeletable population #627 is fixing.
const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmTemp(d);
    } catch {
      // Best-effort, and deliberately so: `rmTemp`'s retry outlasts a handle released moments
      // later, but NOT one the ESM loader holds for the process lifetime. Letting this throw would
      // fail the suite in TEARDOWN with every assertion passing — the exact shape this PR exists to
      // remove. A leaked temp dir is the cheaper failure. Same posture as
      // provider-module-threading.test.ts and scheduler.ts's cleanupReadOnlyDb.
    }
  }
});

function fixture(contents: string): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "otc-provider-"));
  tmpDirs.push(dir);
  writeFileSync(join(dir, "provider.mjs"), contents, "utf8");
  return { dir, file: "provider.mjs" };
}

const GOOD = `export function createEmbeddingProvider() {
  return { id: "m:x", provider: "module", model: "x", dimensions: 3, embed: async (t) => t.map(() => [0,0,0]) };
}`;
const base = { exportName: "createEmbeddingProvider" as const, slot: "embeddings" as const };

const RERANKER_GOOD = `export function createReranker() {
  return async (query, documents, topN) => documents.map((d, i) => ({ index: i, relevanceScore: 1 }));
}`;
const rerankerBase = { exportName: "createReranker" as const, slot: "reranker" as const };

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

  // Review round 2, Finding 1: the original assertUsable checked only embed/dimensions, so a
  // provider missing id/provider/model loaded fine with those fields undefined — and since
  // withRevision derives the vec fingerprint's identity from provider.id, two DIFFERENT module
  // providers at the same width then produced an IDENTICAL fingerprint (no rebuild on a provider
  // swap; the exact bug class Task 6 closed). One test per newly-required field, each omitting
  // ONLY that field so the failure is attributable to that field specifically.
  it("refuses a provider missing id", async () => {
    const { dir, file } = fixture(
      `export function createEmbeddingProvider() {
        return { provider: "module", model: "x", dimensions: 3, embed: async (t) => t.map(() => [0,0,0]) };
      }`,
    );
    let message = "";
    try {
      await loadProviderModule({
        ...base,
        modulePath: file,
        configDir: dir,
        securityProfile: "trusted-local",
      });
    } catch (e) {
      message = JSON.stringify(e);
    }
    expect(message).toContain('"id"');
    expect(message).not.toContain('"provider"');
    expect(message).not.toContain('"model"');
  });

  it("refuses a provider missing provider", async () => {
    const { dir, file } = fixture(
      `export function createEmbeddingProvider() {
        return { id: "m:x", model: "x", dimensions: 3, embed: async (t) => t.map(() => [0,0,0]) };
      }`,
    );
    let message = "";
    try {
      await loadProviderModule({
        ...base,
        modulePath: file,
        configDir: dir,
        securityProfile: "trusted-local",
      });
    } catch (e) {
      message = JSON.stringify(e);
    }
    expect(message).toContain('"provider"');
    expect(message).not.toContain('"id"');
    expect(message).not.toContain('"model"');
  });

  it("refuses a provider missing model", async () => {
    const { dir, file } = fixture(
      `export function createEmbeddingProvider() {
        return { id: "m:x", provider: "module", dimensions: 3, embed: async (t) => t.map(() => [0,0,0]) };
      }`,
    );
    let message = "";
    try {
      await loadProviderModule({
        ...base,
        modulePath: file,
        configDir: dir,
        securityProfile: "trusted-local",
      });
    } catch (e) {
      message = JSON.stringify(e);
    }
    expect(message).toContain('"model"');
    expect(message).not.toContain('"id"');
    expect(message).not.toContain('"provider"');
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

  // Minor 3 (review round 2): an async factory must be AWAITED, not treated as a malformed sync
  // return value.
  it("awaits an async factory rather than treating the Promise as a malformed provider", async () => {
    const { dir, file } = fixture(
      `export async function createEmbeddingProvider() {
        await Promise.resolve();
        return { id: "m:x", provider: "module", model: "x", dimensions: 3, embed: async (t) => t.map(() => [0,0,0]) };
      }`,
    );
    const p = await loadProviderModule<{ dimensions: number }>({
      ...base,
      modulePath: file,
      configDir: dir,
      securityProfile: "trusted-local",
    });
    expect(p.dimensions).toBe(3);
  });
});

// Review round 2, Minor 4: the reranker half of the hatch (registry.ts's RERANKERS.module entry
// and module-loader.ts's `slot === "reranker"` branch) had nothing but a name-list assertion
// exercising it. `rerankerBase`/`RERANKER_GOOD` are declared above, alongside the embeddings ones.
describe("module provider gate — reranker slot", () => {
  it("loads a well-formed reranker module under trusted-local", async () => {
    const { dir, file } = fixture(RERANKER_GOOD);
    const reranker = await loadProviderModule<
      (query: string, documents: string[], topN: number) => Promise<unknown>
    >({ ...rerankerBase, modulePath: file, configDir: dir, securityProfile: "trusted-local" });
    const hits = await reranker("q", ["a", "b"], 2);
    expect(hits).toEqual([
      { index: 0, relevanceScore: 1 },
      { index: 1, relevanceScore: 1 },
    ]);
  });

  it("refuses a reranker module whose export is not a function", async () => {
    const { dir, file } = fixture(
      `export function createReranker() { return { not: "a function" }; }`,
    );
    await expect(
      loadProviderModule({
        ...rerankerBase,
        modulePath: file,
        configDir: dir,
        securityProfile: "trusted-local",
      }),
    ).rejects.toThrow(/Reranker function/);
  });

  it("refuses the reranker module hatch under the hardened security profile", async () => {
    const { dir, file } = fixture(RERANKER_GOOD);
    await expect(
      loadProviderModule({
        ...rerankerBase,
        modulePath: file,
        configDir: dir,
        securityProfile: "hardened",
      }),
    ).rejects.toThrow(/hardened/);
  });
});
