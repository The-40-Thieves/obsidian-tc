// Tests for the embedding-transport vendor-neutrality gate (THE-837).
//
// node:test rather than vitest, for the reason check-boundaries.test.mjs documents: scripts/ sits
// outside every workspace glob and no root vitest config reaches it. `node --test scripts/*.test.mjs`.
//
// Every case below is a way this gate turns into DECORATION rather than breaking loudly, and the
// first two are not hypothetical -- both were found by running the failure probes before trusting
// the gate, and both had already shipped into the first draft:
//   * a prefix-matched map name let the floor pass while the registry had been renamed away
//   * comment stripping that ate newlines reported line 33 for a violation on line 68
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  registryKeys,
  stringLiterals,
  stripComments,
} from "./check-embedding-transport-vendor-neutral.mjs";

const REGISTRY_FIXTURE = `
const EMBEDDINGS: Record<string, EmbeddingsEntry> = {
  ollama: { appendsPath: "/api/embed", build: (c, x) => ollamaProvider(x) },
  openai: { appendsPath: "/embeddings", build: (c, x) => openaiProvider(x) },
  "bge-m3": { appendsPath: "/embeddings", build: (c, x) => bgeM3Provider(x) },
};

const RERANKERS: Record<string, RerankerEntry> = {
  "cohere-compatible": { appendsPath: "/rerank", build: async () => {} },
};
`;

test("registryKeys parses bare and quoted keys from both maps", () => {
  assert.deepEqual(registryKeys(REGISTRY_FIXTURE, "EMBEDDINGS"), ["ollama", "openai", "bge-m3"]);
  assert.deepEqual(registryKeys(REGISTRY_FIXTURE, "RERANKERS"), ["cohere-compatible"]);
});

test("registryKeys is colon-anchored: a RENAMED map yields nothing, so the floor can fire", () => {
  // The real bug this pins. `indexOf("const EMBEDDINGS")` also matches `const EMBEDDINGS_RENAMED`,
  // so the first draft parsed every key out of a map that no longer existed under that name. The
  // floor probe therefore reported a clean scan against a registry that had moved -- a gate that
  // cannot fail proves nothing (CLAUDE.md: "a new gate must be watched failing").
  const renamed = REGISTRY_FIXTURE.replace("const EMBEDDINGS:", "const EMBEDDINGS_RENAMED:");
  assert.deepEqual(registryKeys(renamed, "EMBEDDINGS"), []);
});

test("registryKeys ignores nested keys, so only top-level providers count", () => {
  // `appendsPath:` and `build:` sit at four spaces; only two-space keys are providers. Without the
  // indent anchor the parsed set inflates and MIN_EXPECTED_PROVIDERS passes on garbage.
  assert.ok(!registryKeys(REGISTRY_FIXTURE, "EMBEDDINGS").includes("appendsPath"));
});

test("stripComments preserves line numbering", () => {
  // Replacing a block comment with a single space shifts every subsequent line number. Measured:
  // an injected violation on line 68 was reported as line 33, which sends a reader to the wrong
  // place in a file whose docblocks are longer than its code.
  const source = ["/**", " * a", " * b", " */", 'const x = "ollama";'].join("\n");
  const stripped = stripComments(source);
  assert.equal(stripped.split("\n").length, source.split("\n").length);
  assert.equal(stripped.split("\n")[4], 'const x = "ollama";');
});

test("stripComments removes a vendor named in a comment but keeps one in code", () => {
  // Both halves matter. Comments naming a vendor are legitimate and load-bearing here (http.ts
  // documents the removed branch by name on purpose); a name in CODE is the violation.
  const stripped = stripComments('// ollama is fine here\nconst p = "voyage";');
  assert.ok(!stripped.includes("ollama"));
  assert.ok(stripped.includes("voyage"));
});

test("stripComments does not eat a URL's double slash", () => {
  // `https://host` is not a line comment. Without the `[^:]` guard the rest of the line vanishes,
  // silently hiding any provider name after it.
  const stripped = stripComments('const u = "https://host/api";\nconst p = "cohere";');
  assert.ok(stripped.includes("https://host/api"));
  assert.ok(stripped.includes("cohere"));
});

test("stringLiterals finds double, single and backtick forms", () => {
  const found = stringLiterals(`const a = "one"; const b = 'two'; const c = \`three\`;`).map(
    (s) => s.value,
  );
  assert.deepEqual(found, ["one", "two", "three"]);
});

test("stringLiterals reports an index that maps to the right line", () => {
  const source = 'const a = 1;\nconst b = 2;\nconst p = "ollama";';
  const hit = stringLiterals(source).find((s) => s.value === "ollama");
  assert.ok(hit, "expected the literal to be found");
  assert.equal(source.slice(0, hit.index).split("\n").length, 3);
});
