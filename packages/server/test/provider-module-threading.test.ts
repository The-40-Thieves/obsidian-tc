import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configFromVaultPath } from "../src/cli/args";
import { buildServerRuntime } from "../src/runtime/server-runtime";
import { makeTempDir, rmTemp } from "./tmp";

describe("module hatch — securityProfile threading (embeddings + reranker)", () => {
  const tmpDirs: string[] = [];
  const tmpDir = (prefix: string): string => {
    const d = makeTempDir(prefix);
    tmpDirs.push(d);
    return d;
  };

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      try {
        rmTemp(d);
      } catch {
        // Best-effort: this exercises a FAILED boot, and the assertion under test has already run.
      }
    }
  });

  it("the embeddings module hatch is refused under securityProfile hardened end-to-end (buildServerRuntime -> RuntimeCoreDeps -> wireIndexResources -> createEmbeddingProviderAsync -> loadProviderModule)", async () => {
    const vaultDir = tmpDir("otc-module-thread-vault-");
    const config = configFromVaultPath(vaultDir);
    config.cacheDir = tmpDir("otc-module-thread-cache-");
    config.securityProfile = "hardened";
    config.embeddings.provider = "module";
    config.embeddings.modulePath = "./does-not-matter.mjs";
    // If ANY hop between buildServerRuntime and loadProviderModule drops securityProfile, the
    // `?? "trusted-local"` default takes over and the module is actually IMPORTED — failing with a
    // "could not be imported" / ENOENT-shaped message instead of this one. The regex pins the
    // specific refusal, not just "something threw".
    await expect(buildServerRuntime(config, join(vaultDir, "config.json"))).rejects.toThrow(
      /hardened/,
    );
  });

  it("the reranker module hatch is refused under securityProfile hardened end-to-end (buildServerRuntime -> wireGatewaySeams -> resolveReranker -> loadProviderModule)", async () => {
    const vaultDir = tmpDir("otc-module-thread-vault-");
    const config = configFromVaultPath(vaultDir);
    config.cacheDir = tmpDir("otc-module-thread-cache-");
    config.securityProfile = "hardened";
    // embeddings stays the default (ollama) — only the reranker slot uses the module hatch here,
    // isolating this hop from the embeddings one covered by the sibling test above.
    config.reranker = { provider: "module", modulePath: "./does-not-matter.mjs" };
    await expect(buildServerRuntime(config, join(vaultDir, "config.json"))).rejects.toThrow(
      /hardened/,
    );
  });
});
