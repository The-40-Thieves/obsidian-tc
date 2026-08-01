// Review round 2, Finding 2: the module gate's guards (module-loader.ts / registry.ts) were
// mutation-tested in round 1, but `securityProfile` crosses FOUR hops before it reaches them
// (buildServerRuntime -> RuntimeCoreDeps -> wireIndexResources -> createEmbeddingProviderAsync,
// and separately buildServerRuntime -> wireGatewaySeams), and none of those hops were exercised —
// delete `securityProfile` at any one of them and the hardened refusal goes silently inert with
// the whole existing suite green, because `loadProviderModule`'s own `?? "trusted-local"` fallback
// makes "value absent" indistinguishable from "value dropped in transit".
//
// Chose a BEHAVIOURAL test (construct the real wiring path, assert it rejects) over a source-scan
// count, per the review: `buildServerRuntime` end-to-end is exactly as cheap as the existing
// boot-failure tests in server-runtime.test.ts (same configFromVaultPath + tmp-dir pattern), and
// unlike a synthetic call straight into `wireIndexResources`/`wireGatewaySeams`, it actually
// exercises every hop the value crosses — including `dirname(configPath)` and the
// RuntimeCoreDeps/IndexResourcesDeps plumbing — rather than assuming the outer boot code forwards
// it correctly.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configFromVaultPath } from "../src/cli/args";
import { buildServerRuntime } from "../src/runtime/server-runtime";

describe("module hatch — securityProfile threading (embeddings + reranker)", () => {
  const tmpDirs: string[] = [];
  const tmpDir = (prefix: string): string => {
    const d = mkdtempSync(join(tmpdir(), prefix));
    tmpDirs.push(d);
    return d;
  };

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
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
