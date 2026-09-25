import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load";
import { buildLocalEmbeddingProvider } from "../src/providers/registry";

// THE-1122 review round 3 — adopted from a cross-vendor adversarial verifier (Codex) that failed
// PR #980's release-reachability contract. Kept as a permanent regression test, not a one-off.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const text = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("THE-1122 adversarial release contracts", () => {
  it("ships embedder-local in a real, shipped dependency section (optionalDependencies)", () => {
    const pkg = JSON.parse(text("packages/server/package.json")) as Record<
      string,
      Record<string, string> | undefined
    >;
    const sections = ["dependencies", "optionalDependencies", "peerDependencies"];
    const sectionFor = (name: string) =>
      sections.find((section) => pkg[section]?.[name] !== undefined);
    const embedder = "@the-40-thieves/obsidian-tc-embedder-local";
    // NOT compared against reranker-local's own section (the verifier's original assertion did,
    // and this repo's own review round explicitly rejected that premise): a missing reranker
    // degrades gracefully to RRF-only, so reranker-local staying undeclared is fine and
    // deliberately out of this ticket's scope; a missing DEFAULT embedder makes every
    // search_semantic reject, which is why embedder-local specifically needs a REAL section.
    expect(
      sectionFor(embedder),
      "embedder-local must be declared in a shipped dependency section",
    ).toBeTruthy();
    expect(sectionFor(embedder)).toBe("optionalDependencies");
  });

  it("copies embedder-local into the Docker runtime image", () => {
    const dockerfile = text("Dockerfile");
    expect(dockerfile).toMatch(/COPY[^\n]*embedder-local/);
    expect(dockerfile).not.toMatch(
      /embedder-local[^\n]*UNREACHABLE|UNREACHABLE[^\n]*embedder-local/i,
    );
  });

  it("rejects an explicit local provider without cacheDir at config load", () => {
    const tmpConfig = join(ROOT, "packages/server/test/fixtures/local-embedder-no-cache-dir.json");
    expect(() => loadConfig(tmpConfig)).toThrow(/cacheDir/);
  });

  it("includes revision and quantization in local provider identity", () => {
    const base = {
      provider: "local",
      model: "all-MiniLM-L6-v2",
      dimensions: 384,
      revision: "revision-a",
      quantized: true,
    };
    const resolve = async () => ({ ok: false as const, attempts: [], inSourceCheckout: false });
    const a = buildLocalEmbeddingProvider(base, { cacheDir: "/tmp/verify-1122" }, resolve);
    const b = buildLocalEmbeddingProvider(
      { ...base, revision: "revision-b" },
      { cacheDir: "/tmp/verify-1122" },
      resolve,
    );
    const fp32 = buildLocalEmbeddingProvider(
      { ...base, quantized: false },
      { cacheDir: "/tmp/verify-1122" },
      resolve,
    );
    expect(b.id).not.toBe(a.id);
    expect(fp32.id).not.toBe(a.id);
  });

  it("exercises search_semantic end-to-end in CI (zero-config-smoke-local-embeddings)", () => {
    // Residual, accepted explicitly by the owner's review round rather than fixed here:
    // ci-install-smoke.yml does not itself exercise search_semantic — the NEW
    // zero-config-smoke-local-embeddings job in ci-server.yml is what does (see that job's own
    // header comment for why it is a separate job from the plain zero-config-smoke one). Listed
    // in the PR body's Residuals section.
    expect(text(".github/workflows/ci-server.yml")).toContain("search_semantic");
  });

  it("uses the required cautious measurement wording on every named surface", () => {
    const paths = [
      "docs/EVALUATION.md",
      "docs/src/content/docs/configuration/embeddings.md",
      "packages/embedder-local/src/model-info.ts",
      "packages/shared/src/config/indexing-embeddings.schema.ts",
      "CHANGELOG.md",
    ];
    for (const path of paths) {
      const source = text(path);
      expect(source, path).toMatch(
        /non-inferiority not established at this corpus(?:'s)?\s+resolution/i,
      );
      expect(source, path).toMatch(/MiniLM(?:'s)? deficit[\s\S]{0,80}detected/i);
      expect(source, path).toMatch(
        /nomic[\s\S]{0,160}conservative choice[\s\S]{0,160}underpowered/i,
      );
    }
  });
});
