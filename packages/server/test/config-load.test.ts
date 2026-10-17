import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyEnvOverlays,
  finalizeConfig,
  isEmbeddingsModelExplicit,
  isPlaneEnabledExplicit,
  loadConfig,
} from "../src/config/load";
import { configureProviderPlainHttp, providerPlainHttpHosts } from "../src/gateway/provider-fetch";
import { makeTempDir, rmTemp } from "./tmp";

let dir: string;
beforeEach(() => {
  dir = makeTempDir("otc-cfg-");
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
// Deployment overlays (PORT, OBSIDIAN_TC_PUBLIC_URL, ...). Each one is a single env->path mapping in
// applyEnvOverlays, the one overlay both boot and `config explain` run. Precedence is env > file >
// default: the overlay writes into the raw file object before the schema defaults apply.
describe("deployment env overlays (applyEnvOverlays / finalizeConfig)", () => {
  const VAULT = { id: "main", path: "/data/vault" };
  const SECRET = "s".repeat(40);
  type Http = { transports: { http: Record<string, unknown> } };

  it("PORT sets transports.http.port and enables the HTTP transport when unset", () => {
    expect(applyEnvOverlays({}, { PORT: "8080" }) as Http).toMatchObject({
      transports: { http: { port: 8080, enabled: true } },
    });
  });

  it("PORT leaves transports.http.enabled alone when the file explicitly disabled it", () => {
    expect(
      applyEnvOverlays({ transports: { http: { enabled: false } } }, { PORT: "8080" }) as Http,
    ).toMatchObject({ transports: { http: { enabled: false, port: 8080 } } });
  });

  it("ignores empty overlay variables and leaves the raw object untouched", () => {
    const raw = { vaults: [VAULT], cacheDir: "/c", transports: { http: { port: 9000 } } };
    const before = structuredClone(raw);
    applyEnvOverlays(raw, {
      PORT: "",
      OBSIDIAN_TC_PUBLIC_URL: "",
      OBSIDIAN_TC_JWKS_URI: "",
      OBSIDIAN_TC_VAULT_PATH: "",
      OBSIDIAN_TC_CACHE_DIR: "",
    });
    expect(raw).toEqual(before);
  });

  it.each(["0", "65536", "-1", "80.5", "8080x", "http"])(
    "refuses PORT=%s with an error naming PORT",
    (port) => {
      expect(() => applyEnvOverlays({}, { PORT: port })).toThrow(/PORT/);
    },
  );

  it("OBSIDIAN_TC_PUBLIC_URL sets auth.resource to the /mcp URL and allows its host", () => {
    expect(
      applyEnvOverlays({}, { OBSIDIAN_TC_PUBLIC_URL: "https://vault.example.com" }),
    ).toMatchObject({
      auth: { resource: "https://vault.example.com/mcp" },
      transports: { http: { allowedHosts: ["vault.example.com"] } },
    });
  });

  it("OBSIDIAN_TC_PUBLIC_URL keeps an explicit port in the allowed host and never duplicates one", () => {
    expect(
      applyEnvOverlays(
        { transports: { http: { allowedHosts: ["vault.example.com"] } } },
        { OBSIDIAN_TC_PUBLIC_URL: "https://vault.example.com:8443/" },
      ),
    ).toMatchObject({
      auth: { resource: "https://vault.example.com:8443/mcp" },
      transports: { http: { allowedHosts: ["vault.example.com", "vault.example.com:8443"] } },
    });
    const again = applyEnvOverlays(
      { transports: { http: { allowedHosts: ["vault.example.com"] } } },
      { OBSIDIAN_TC_PUBLIC_URL: "https://vault.example.com" },
    ) as Http;
    expect(again.transports.http.allowedHosts).toEqual(["vault.example.com"]);
  });

  it.each([
    "http://vault.example.com",
    "vault.example.com",
    "https://vault.example.com/mcp",
    "https://vault.example.com?x=1",
    "not a url",
  ])("refuses OBSIDIAN_TC_PUBLIC_URL=%s with an error naming the variable", (url) => {
    expect(() => applyEnvOverlays({}, { OBSIDIAN_TC_PUBLIC_URL: url })).toThrow(
      /OBSIDIAN_TC_PUBLIC_URL/,
    );
  });

  it("OBSIDIAN_TC_JWKS_URI sets auth.jwksUri", () => {
    expect(
      applyEnvOverlays({}, { OBSIDIAN_TC_JWKS_URI: "https://as.example.com/jwks" }),
    ).toMatchObject({ auth: { jwksUri: "https://as.example.com/jwks" } });
  });

  it("OBSIDIAN_TC_VAULT_PATH creates the one vault when the config has none", () => {
    expect(applyEnvOverlays({}, { OBSIDIAN_TC_VAULT_PATH: "/data/vault" })).toMatchObject({
      vaults: [{ id: "main", path: "/data/vault" }],
    });
  });

  it("OBSIDIAN_TC_VAULT_PATH replaces the path of the one configured vault and keeps its id", () => {
    expect(
      applyEnvOverlays(
        { vaults: [{ id: "notes", path: "/old", name: "Notes" }] },
        { OBSIDIAN_TC_VAULT_PATH: "/data/vault" },
      ),
    ).toMatchObject({ vaults: [{ id: "notes", path: "/data/vault", name: "Notes" }] });
  });

  it("OBSIDIAN_TC_VAULT_PATH refuses a config with several vaults rather than guessing", () => {
    expect(() =>
      applyEnvOverlays(
        {
          vaults: [
            { id: "a", path: "/a" },
            { id: "b", path: "/b" },
          ],
        },
        { OBSIDIAN_TC_VAULT_PATH: "/data/vault" },
      ),
    ).toThrow(/OBSIDIAN_TC_VAULT_PATH/);
  });

  it("OBSIDIAN_TC_CACHE_DIR sets cacheDir", () => {
    expect(
      applyEnvOverlays({ cacheDir: "/old" }, { OBSIDIAN_TC_CACHE_DIR: "/data/cache" }),
    ).toMatchObject({ cacheDir: "/data/cache" });
  });

  it("env wins over the file for every overlay (precedence: env > file > default)", () => {
    const cfg = finalizeConfig(
      {
        vaults: [{ id: "main", path: "/file/vault" }],
        cacheDir: "/file/cache",
        transports: { http: { port: 9000, host: "127.0.0.1" } },
      },
      { OBSIDIAN_TC_VAULT_PATH: "/env/vault", OBSIDIAN_TC_CACHE_DIR: "/env/cache", PORT: "9100" },
    );
    expect(cfg.vaults[0]?.path).toBe("/env/vault");
    expect(cfg.cacheDir).toBe("/env/cache");
    expect(cfg.transports.http.port).toBe(9100);
  });

  it("refuses PORT with a non-loopback host while auth.mode is none", () => {
    expect(() =>
      finalizeConfig(
        { vaults: [VAULT], cacheDir: "/c", transports: { http: { host: "0.0.0.0" } } },
        { PORT: "8080" },
      ),
    ).toThrow(/non-loopback/);
  });

  it("accepts the container shape: PORT, PUBLIC_URL, a JWT secret and a 0.0.0.0 host", () => {
    const cfg = finalizeConfig(
      {
        vaults: [VAULT],
        cacheDir: "/c",
        auth: { mode: "jwt" },
        transports: { http: { host: "0.0.0.0" } },
      },
      {
        PORT: "8080",
        OBSIDIAN_TC_PUBLIC_URL: "https://vault.example.com",
        OBSIDIAN_TC_JWT_SECRET: SECRET,
      },
    );
    expect(cfg.transports.http).toMatchObject({ enabled: true, port: 8080, host: "0.0.0.0" });
    expect(cfg.auth.resource).toBe("https://vault.example.com/mcp");
  });
});

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

// Every provider client's default transport reads network.plainHttpHosts from one process-wide list
// (gateway/provider-fetch.ts); finalizeConfig, the one place every config path passes through, sets it.
describe("network.plainHttpHosts reaches the provider transport", () => {
  afterEach(() => configureProviderPlainHttp([]));

  it("loadConfig hands the list to the provider transport", () => {
    configureProviderPlainHttp([]);
    const cfg = loadConfig(
      writeConfig({
        vaults: [{ id: "v1", path: "/tmp/v1" }],
        network: { plainHttpHosts: ["litellm"] },
      }),
    );
    expect(cfg.network.plainHttpHosts).toEqual(["litellm"]);
    expect(providerPlainHttpHosts()).toEqual(["litellm"]);
  });

  it("a config without the block resets the list to empty", () => {
    configureProviderPlainHttp(["stale"]);
    loadConfig(writeConfig({ vaults: [{ id: "v1", path: "/tmp/v1" }] }));
    expect(providerPlainHttpHosts()).toEqual([]);
  });

  it("a malformed entry fails config load", () => {
    expect(() =>
      loadConfig(
        writeConfig({
          vaults: [{ id: "v1", path: "/tmp/v1" }],
          network: { plainHttpHosts: ["*.lan"] },
        }),
      ),
    ).toThrow(/network\.plainHttpHosts/);
  });
});
