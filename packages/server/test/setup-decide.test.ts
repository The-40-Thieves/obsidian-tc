// `obsidian-tc setup`'s embeddings decision (PR A of GH #995's two-part follow-up) — every branch
// driven by injected inputs, no real vault/Ollama/cache-db needed (see decide.ts's own header for
// why this module is pure).
import { describe, expect, it } from "vitest";
import { decideSetup, LOW_RAM_THRESHOLD_MB, type SetupInputs } from "../src/cli/setup/decide";

const VAULTS = [{ id: "main", path: "/vault" }];
const baseInput: SetupInputs = {
  vaults: VAULTS,
  cacheDir: "/home/x/.obsidian-tc",
  totalMemMb: 16_000,
  localEmbedderAvailable: false,
  env: {},
};

describe("decideSetup — embeddings precedence", () => {
  it("an existing index's provider always wins, even when local is available", () => {
    const d = decideSetup({
      ...baseInput,
      localEmbedderAvailable: true,
      existingIndex: {
        provider: "ollama",
        model: "nomic-embed-text",
        dimensions: 768,
        source: "kept-from-index",
        keptFromStoredModel: "ollama:nomic-embed-text",
      },
    });
    expect(d.embeddings).toMatchObject({
      provider: "ollama",
      model: "nomic-embed-text",
      dimensions: 768,
    });
    expect(d.embeddings?.reason).toMatch(/existing index/i);
  });

  it("existingIndex with source 'default' (nothing to keep) does NOT pin — falls through", () => {
    const d = decideSetup({
      ...baseInput,
      localEmbedderAvailable: true,
      existingIndex: {
        provider: "local",
        model: "nomic-embed-text-v1.5",
        dimensions: 768,
        source: "default",
      },
    });
    expect(d.embeddings?.provider).toBe("local");
    expect(d.embeddings?.reason).not.toMatch(/kept from/i);
  });

  it("local available, no RAM constraint -> local + default catalog model", () => {
    const d = decideSetup({ ...baseInput, localEmbedderAvailable: true });
    expect(d.embeddings).toMatchObject({
      provider: "local",
      model: "nomic-embed-text-v1.5",
      dimensions: 768,
    });
    expect(d.embeddings?.notice).toBeUndefined();
  });

  it("local available, low RAM -> the smaller local catalog model", () => {
    const d = decideSetup({
      ...baseInput,
      localEmbedderAvailable: true,
      totalMemMb: LOW_RAM_THRESHOLD_MB - 1,
    });
    expect(d.embeddings).toMatchObject({
      provider: "local",
      model: "all-MiniLM-L6-v2",
      dimensions: 384,
    });
    expect(d.embeddings?.reason).toMatch(/RAM/);
  });

  it("local unavailable, Ollama running with a known embed model -> ollama", () => {
    const d = decideSetup({
      ...baseInput,
      localEmbedderAvailable: false,
      ollama: { reachable: true, models: ["llama3.2:latest", "nomic-embed-text:latest"] },
    });
    expect(d.embeddings).toMatchObject({
      provider: "ollama",
      model: "nomic-embed-text",
      dimensions: 768,
    });
  });

  it("Ollama running but with no known embedding model pulled -> falls through to local anyway", () => {
    const d = decideSetup({
      ...baseInput,
      localEmbedderAvailable: false,
      localUnavailableReason: "package not resolvable",
      ollama: { reachable: true, models: ["llama3.2:latest"] },
    });
    expect(d.embeddings?.provider).toBe("local");
    expect(d.embeddings?.notice).toMatch(/package not resolvable/);
  });

  it("neither local nor Ollama available -> local anyway, with a notice naming the reason", () => {
    const d = decideSetup({
      ...baseInput,
      localEmbedderAvailable: false,
      localUnavailableReason: "darwin-x64 has no onnxruntime-node prebuild",
      ollama: { reachable: false, models: [] },
    });
    expect(d.embeddings?.provider).toBe("local");
    expect(d.embeddings?.notice).toMatch(/darwin-x64/);
  });

  it("a hosted API key present in the env is SUGGESTED, never auto-chosen", () => {
    const d = decideSetup({
      ...baseInput,
      localEmbedderAvailable: true,
      env: { OPENAI_API_KEY: "sk-test", UNRELATED: "x" },
    });
    expect(d.embeddings?.provider).toBe("local"); // unaffected
    expect(d.hostedSuggestions).toEqual([{ provider: "openai", envVar: "OPENAI_API_KEY" }]);
  });

  it("no hosted keys present -> empty suggestions list", () => {
    const d = decideSetup({ ...baseInput, localEmbedderAvailable: true });
    expect(d.hostedSuggestions).toEqual([]);
  });

  it("multiple hosted keys present are all surfaced", () => {
    const d = decideSetup({
      ...baseInput,
      localEmbedderAvailable: true,
      env: { VOYAGE_API_KEY: "v", COHERE_API_KEY: "c" },
    });
    expect(d.hostedSuggestions.map((s) => s.provider).sort()).toEqual(["cohere", "voyage"]);
  });

  it("passes vaults and cacheDir through unchanged", () => {
    const d = decideSetup({ ...baseInput, localEmbedderAvailable: true });
    expect(d.vaults).toEqual(VAULTS);
    expect(d.cacheDir).toBe("/home/x/.obsidian-tc");
  });

  // Fix round (Codex review 1001-verify), finding 1 (HIGH): an unmappable stored provider id
  // (module:*, openai-compatible:*, ...) must never become a guessed, explicit provider.
  it("existingIndex.unmappableFallback -> REFUSES to write embeddings, never guesses ollama", () => {
    const d = decideSetup({
      ...baseInput,
      localEmbedderAvailable: true,
      existingIndex: {
        provider: "ollama",
        model: "nomic-embed-text",
        dimensions: 1536,
        source: "kept-from-index",
        keptFromStoredModel: "module:corp-embed",
        unmappableFallback: true,
      },
    });
    expect(d.embeddings).toBeUndefined();
    expect(d.refusal).toBeDefined();
    expect(d.refusal).toMatch(/module:corp-embed/);
    expect(d.refusal).toMatch(/1536/);
  });

  // Finding 3 (HIGH): a kept identity's revision must survive into the decision so the written
  // config reproduces the SAME provider id / vec fingerprint.
  it("existingIndex.revision is carried into the embeddings decision", () => {
    const d = decideSetup({
      ...baseInput,
      localEmbedderAvailable: true,
      existingIndex: {
        provider: "ollama",
        model: "nomic-embed-text",
        dimensions: 768,
        source: "kept-from-index",
        keptFromStoredModel: "ollama:nomic-embed-text@sha123",
        revision: "sha123",
      },
    });
    expect(d.embeddings?.revision).toBe("sha123");
  });

  // Finding 5 (MEDIUM): an ambiguous orphaned index (some OTHER vault id's rows in the same cache
  // dir) must never be cemented as this vault's own explicit config.
  it("existingIndex source ambiguous-orphaned-index -> REFUSES, does not cement the unrelated index", () => {
    const d = decideSetup({
      ...baseInput,
      localEmbedderAvailable: true,
      existingIndex: {
        provider: "ollama",
        model: "nomic-embed-text",
        dimensions: 768,
        source: "ambiguous-orphaned-index",
        keptFromStoredModel: "ollama:nomic-embed-text",
      },
    });
    expect(d.embeddings).toBeUndefined();
    expect(d.refusal).toBeDefined();
    expect(d.refusal).toMatch(/ambiguous|orphaned|DIFFERENT vault id/i);
  });

  // Fix round 2 (Codex review 1001-verify-r2), finding 3 (HIGH): `source: "default"` still means a
  // cache.db EXISTS for this vault (probeEmbeddingsProviderSource returns undefined outright when
  // there is none) — either nothing has been indexed yet, or every active row already belongs to
  // the local family. A reachable Ollama on THIS box must never be reason enough to write a
  // DIFFERENT explicit provider than what boot would keep sticky to on the very next run.
  it("existingIndex source 'default' (cache dir exists, nothing to keep) never picks Ollama, even when reachable and local is not", () => {
    const d = decideSetup({
      ...baseInput,
      localEmbedderAvailable: false,
      localUnavailableReason: "package not resolvable",
      existingIndex: {
        provider: "local",
        model: "nomic-embed-text-v1.5",
        dimensions: 768,
        source: "default",
      },
      ollama: { reachable: true, models: ["nomic-embed-text:latest"] },
    });
    expect(d.embeddings?.provider).toBe("local");
    expect(d.embeddings?.provider).not.toBe("ollama");
  });

  // Finding 4 (MEDIUM): the ambiguous-orphaned-index refusal must fire regardless of whether a
  // kept identity was found among the orphaned rows — sticky's "the orphaned rows already belong to
  // the default family" result carries source: "ambiguous-orphaned-index" with NO
  // keptFromStoredModel, and the original refusal check was nested inside
  // `keptFromStoredModel !== undefined`, so this exact shape fell through to decideFreshEmbeddings
  // instead of refusing.
  it("ambiguous-orphaned-index with NO kept identity still REFUSES (does not fall through to a fresh pick)", () => {
    const d = decideSetup({
      ...baseInput,
      localEmbedderAvailable: false,
      localUnavailableReason: "package not resolvable",
      existingIndex: {
        provider: "local",
        model: "nomic-embed-text-v1.5",
        dimensions: 768,
        source: "ambiguous-orphaned-index",
        // keptFromStoredModel intentionally absent — "found nothing to keep" shape.
      },
      ollama: { reachable: true, models: ["nomic-embed-text:latest"] },
    });
    expect(d.embeddings).toBeUndefined();
    expect(d.refusal).toBeDefined();
    expect(d.refusal).toMatch(/ambiguous|orphaned/i);
  });
});
