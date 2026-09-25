import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isEmbeddingsModelExplicit, isPlaneEnabledExplicit, loadConfig } from "../src/config/load";
import { rmTemp } from "./tmp";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "otc-cfg-"));
});
afterEach(() => {
  rmTemp(dir);
  process.env.OBSIDIAN_TC_JWT_SECRET = "";
});

// THE-1122 review round 3: cacheDir is now REQUIRED whenever the resolved embeddings.provider is
// "local" (explicit or the default) — see finalizeConfig's own enforcement and the
// "cacheDir requirement" describe block below for that behavior's own tests. Every OTHER test in
// this file is about something else entirely, so writeConfig injects a default cacheDir unless
// the caller's own object already sets one (spread order: obj's own key wins), keeping every
// existing test's actual subject unaffected by this new requirement.
function writeConfig(obj: Record<string, unknown>): string {
  const withCacheDir = { cacheDir: ".otc-test-cache", ...obj };
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify(withCacheDir), "utf8");
  return p;
}

/** For the "no cacheDir" enforcement tests specifically — writeConfig's own default would defeat
 *  the point of testing its absence. */
function writeConfigWithoutCacheDirDefault(obj: Record<string, unknown>): string {
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify(obj), "utf8");
  return p;
}

describe("loadConfig", () => {
  it("parses a minimal config and applies schema defaults", () => {
    const cfg = loadConfig(writeConfig({ vaults: [{ id: "v1", path: "/tmp/v1" }] }));
    expect(cfg.vaults[0]?.id).toBe("v1");
    expect(cfg.auth.mode).toBe("none");
    expect(cfg.transports.stdio).toBe(true);
    expect(cfg.governor.maxResponseBytes).toBe(1_000_000);
  });

  // THE-1122 review: `embeddings.model`/`.dimensions` are plain schema defaults now (not
  // provider-conditional — see indexing-embeddings.schema.ts's own comment), so a config that sets
  // ONLY `provider: "ollama"` needs a config-LOADER-level restoration of the historical
  // "nomic-embed-text"/768 pairing, or Ollama gets asked for a model it was never told to pull.
  it("an absent embeddings block defaults to the local provider (unchanged)", () => {
    const cfg = loadConfig(writeConfig({ vaults: [{ id: "v1", path: "/tmp/v1" }] }));
    expect(cfg.embeddings.provider).toBe("local");
    expect(cfg.embeddings.model).toBe("nomic-embed-text-v1.5");
    expect(cfg.embeddings.dimensions).toBe(768);
  });

  it("provider 'ollama' with no explicit model restores the historical Ollama-shaped default", () => {
    const cfg = loadConfig(
      writeConfig({
        vaults: [{ id: "v1", path: "/tmp/v1" }],
        embeddings: { provider: "ollama" },
      }),
    );
    expect(cfg.embeddings.model).toBe("nomic-embed-text");
    expect(cfg.embeddings.dimensions).toBe(768);
  });

  it("provider 'ollama' WITH an explicit model is never overridden", () => {
    const cfg = loadConfig(
      writeConfig({
        vaults: [{ id: "v1", path: "/tmp/v1" }],
        embeddings: { provider: "ollama", model: "qwen3-embedding:4b", dimensions: 2560 },
      }),
    );
    expect(cfg.embeddings.model).toBe("qwen3-embedding:4b");
    expect(cfg.embeddings.dimensions).toBe(2560);
  });

  it("provider 'local' explicit (no model) is unaffected by the ollama restoration", () => {
    const cfg = loadConfig(
      writeConfig({
        vaults: [{ id: "v1", path: "/tmp/v1" }],
        embeddings: { provider: "local" },
      }),
    );
    expect(cfg.embeddings.model).toBe("nomic-embed-text-v1.5");
  });

  // THE-1122 review item 7: `embeddings.dimensions`'s schema default (768) is likewise
  // provider-agnostic, so selecting a 384-dim catalog entry with no explicit `dimensions`
  // previously inherited the WRONG width silently and crashed far away, at vec0 column creation.
  it("provider 'local' with a 384-dim model and no explicit dimensions derives 384, not the 768 schema default", () => {
    const cfg = loadConfig(
      writeConfig({
        vaults: [{ id: "v1", path: "/tmp/v1" }],
        embeddings: { provider: "local", model: "all-MiniLM-L6-v2" },
      }),
    );
    expect(cfg.embeddings.dimensions).toBe(384);
  });

  it("provider 'local' with bge-small-en-v1.5 and no explicit dimensions also derives 384", () => {
    const cfg = loadConfig(
      writeConfig({
        vaults: [{ id: "v1", path: "/tmp/v1" }],
        embeddings: { provider: "local", model: "bge-small-en-v1.5" },
      }),
    );
    expect(cfg.embeddings.dimensions).toBe(384);
  });

  it("provider 'local' with an explicit dimensions matching the catalog entry is accepted as-is", () => {
    const cfg = loadConfig(
      writeConfig({
        vaults: [{ id: "v1", path: "/tmp/v1" }],
        embeddings: { provider: "local", model: "all-MiniLM-L6-v2", dimensions: 384 },
      }),
    );
    expect(cfg.embeddings.dimensions).toBe(384);
  });

  it("provider 'local' with an explicit dimensions that contradicts the model's native width is rejected, naming both numbers", () => {
    expect(() =>
      loadConfig(
        writeConfig({
          vaults: [{ id: "v1", path: "/tmp/v1" }],
          embeddings: { provider: "local", model: "all-MiniLM-L6-v2", dimensions: 768 },
        }),
      ),
    ).toThrow(/384/);
    expect(() =>
      loadConfig(
        writeConfig({
          vaults: [{ id: "v1", path: "/tmp/v1" }],
          embeddings: { provider: "local", model: "all-MiniLM-L6-v2", dimensions: 768 },
        }),
      ),
    ).toThrow(/768/);
  });

  it("provider 'local' with truncate: true and a NARROWER explicit dimensions is accepted (MRL truncation)", () => {
    const cfg = loadConfig(
      writeConfig({
        vaults: [{ id: "v1", path: "/tmp/v1" }],
        embeddings: {
          provider: "local",
          model: "nomic-embed-text-v1.5",
          dimensions: 256,
          truncate: true,
        },
      }),
    );
    expect(cfg.embeddings.dimensions).toBe(256);
  });

  it("provider 'local' with truncate: true but a WIDER explicit dimensions is still rejected (cannot truncate to something wider)", () => {
    expect(() =>
      loadConfig(
        writeConfig({
          vaults: [{ id: "v1", path: "/tmp/v1" }],
          embeddings: {
            provider: "local",
            model: "all-MiniLM-L6-v2",
            dimensions: 768,
            truncate: true,
          },
        }),
      ),
    ).toThrow(/384/);
  });

  it("provider 'local' with an unrecognized model name is left alone (embedder-local's own resolution refuses it later)", () => {
    const cfg = loadConfig(
      writeConfig({
        vaults: [{ id: "v1", path: "/tmp/v1" }],
        embeddings: { provider: "local", model: "not-a-real-catalog-entry" },
      }),
    );
    // The schema's own unconditional default (768) is what a name this fix has no catalog data
    // for falls back to — unchanged from before this fix.
    expect(cfg.embeddings.dimensions).toBe(768);
  });

  it("overlays the JWT secret from the environment", () => {
    process.env.OBSIDIAN_TC_JWT_SECRET = "x".repeat(40);
    const cfg = loadConfig(
      writeConfig({ vaults: [{ id: "v1", path: "/tmp/v1" }], auth: { mode: "jwt" } }),
    );
    expect(cfg.auth.mode).toBe("jwt");
    expect((cfg.auth as { jwtSecret?: string }).jwtSecret).toHaveLength(40);
  });

  it("rejects an invalid config", () => {
    expect(() => loadConfig(writeConfig({ vaults: [] }))).toThrow();
  });

  it("strips a leading UTF-8 BOM before parsing (THE-185)", () => {
    const p = join(dir, "bom.json");
    writeFileSync(
      p,
      `\uFEFF${JSON.stringify({
        vaults: [{ id: "v1", path: "/tmp/v1" }],
        cacheDir: ".otc-test-cache",
      })}`,
      "utf8",
    );
    expect(loadConfig(p).vaults[0]?.id).toBe("v1");
  });
});

// THE-1122 review round 3: the provider factory (buildLocalEmbeddingProvider) already failed
// closed when ctx.cacheDir was absent, but config LOAD never asked \u2014 that failure only ever
// surfaced far later, at first embed, with a caller-specific error rather than one naming the
// actual config problem. See isCacheDirExplicit's own doc comment for why this is scoped to
// provider "local" specifically, and configFromVaultPath (cli/resolve-config.ts) for the one
// call site (the true zero-config CLI front door) that supplies cacheDir itself rather than
// tripping this.
describe("cacheDir requirement for provider 'local' (THE-1122 review round 3)", () => {
  it("rejects an explicit provider 'local' config with no cacheDir, naming cacheDir", () => {
    const p = writeConfigWithoutCacheDirDefault({
      vaults: [{ id: "v1", path: "/tmp/v1" }],
      embeddings: { provider: "local" },
    });
    expect(() => loadConfig(p)).toThrow(/cacheDir/);
  });

  it("rejects a config with NO embeddings block at all (provider defaults to 'local') and no cacheDir", () => {
    const p = writeConfigWithoutCacheDirDefault({ vaults: [{ id: "v1", path: "/tmp/v1" }] });
    expect(() => loadConfig(p)).toThrow(/cacheDir/);
  });

  it("does NOT reject a non-local provider with no cacheDir \u2014 the schema default is fine there", () => {
    const p = writeConfigWithoutCacheDirDefault({
      vaults: [{ id: "v1", path: "/tmp/v1" }],
      embeddings: { provider: "ollama" },
    });
    expect(() => loadConfig(p)).not.toThrow();
  });

  it("accepts an explicit provider 'local' config once cacheDir is set", () => {
    const p = writeConfigWithoutCacheDirDefault({
      vaults: [{ id: "v1", path: "/tmp/v1" }],
      embeddings: { provider: "local" },
      cacheDir: ".otc-test-cache",
    });
    expect(() => loadConfig(p)).not.toThrow();
  });
});

// THE-825: `isPlaneEnabledExplicit` is the signal that distinguishes "the raw config never
// mentioned plane.enabled" (defaulted) from "the raw config set plane.enabled: false on purpose"
// (deliberate opt-out) -- the two are indistinguishable once ServerConfigSchema.parse has run.
describe("isPlaneEnabledExplicit (THE-825)", () => {
  it("false when the raw config has no plane block at all", () => {
    expect(isPlaneEnabledExplicit({ vaults: [] })).toBe(false);
  });

  it("false when plane is present but enabled is not", () => {
    expect(isPlaneEnabledExplicit({ plane: { intervalMinutes: 120 } })).toBe(false);
  });

  it("true when the raw config explicitly set plane.enabled: false", () => {
    expect(isPlaneEnabledExplicit({ plane: { enabled: false } })).toBe(true);
  });

  it("true when the raw config explicitly set plane.enabled: true", () => {
    expect(isPlaneEnabledExplicit({ plane: { enabled: true } })).toBe(true);
  });

  it("false when plane is present but not an object (malformed, schema will reject it later)", () => {
    expect(isPlaneEnabledExplicit({ plane: "nope" })).toBe(false);
    expect(isPlaneEnabledExplicit({ plane: null })).toBe(false);
    expect(isPlaneEnabledExplicit({ plane: ["enabled"] })).toBe(false);
  });
});

describe("isEmbeddingsModelExplicit", () => {
  it("false when embeddings is absent entirely", () => {
    expect(isEmbeddingsModelExplicit({})).toBe(false);
  });

  it("false when embeddings is present but model is not", () => {
    expect(isEmbeddingsModelExplicit({ embeddings: { provider: "ollama" } })).toBe(false);
  });

  it("true when the raw config explicitly set embeddings.model", () => {
    expect(isEmbeddingsModelExplicit({ embeddings: { model: "x" } })).toBe(true);
  });

  it("false when embeddings is present but not an object (malformed, schema rejects it later)", () => {
    expect(isEmbeddingsModelExplicit({ embeddings: "nope" })).toBe(false);
    expect(isEmbeddingsModelExplicit({ embeddings: null })).toBe(false);
    expect(isEmbeddingsModelExplicit({ embeddings: ["model"] })).toBe(false);
  });
});
