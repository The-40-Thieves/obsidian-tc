import { describe, expect, it } from "vitest";
import {
  catalogModelNames,
  DEFAULT_MODEL_NAME,
  dtypeFor,
  MODEL_CATALOG,
  modelInfoByName,
  pinnedFilesFor,
} from "../src/model-info.js";

describe("MODEL_CATALOG", () => {
  it("has no EmbeddingGemma or model2vec/potion entry — both were evaluated and dropped", () => {
    const names = catalogModelNames();
    expect(names.some((n) => n.toLowerCase().includes("gemma"))).toBe(false);
    expect(names.some((n) => n.toLowerCase().includes("potion"))).toBe(false);
  });

  it("every entry's license is OSI-approved (apache-2.0 or mit) — never 'gemma'", () => {
    for (const m of MODEL_CATALOG) {
      expect(["apache-2.0", "mit"]).toContain(m.license);
    }
  });

  it("DEFAULT_MODEL_NAME resolves to a real catalog entry", () => {
    expect(modelInfoByName(DEFAULT_MODEL_NAME)).toBeDefined();
  });

  it("modelInfoByName returns undefined for an unknown name", () => {
    expect(modelInfoByName("does-not-exist")).toBeUndefined();
  });
});

describe("pinnedFilesFor / dtypeFor", () => {
  it("selects the quantized onnx file (and dtype q8) when quantized=true", () => {
    const info = modelInfoByName(DEFAULT_MODEL_NAME);
    if (!info) throw new Error("unreachable");
    const files = pinnedFilesFor(info, true);
    expect(files.some((f) => f.path === info.quantized.onnxFile.path)).toBe(true);
    expect(files.some((f) => f.path === info.fp32.onnxFile.path)).toBe(false);
    expect(dtypeFor(info, true)).toBe(info.quantized.dtype);
  });

  it("selects the fp32 onnx file (and dtype fp32) when quantized=false", () => {
    const info = modelInfoByName(DEFAULT_MODEL_NAME);
    if (!info) throw new Error("unreachable");
    const files = pinnedFilesFor(info, false);
    expect(files.some((f) => f.path === info.fp32.onnxFile.path)).toBe(true);
    expect(files.some((f) => f.path === info.quantized.onnxFile.path)).toBe(false);
    expect(dtypeFor(info, false)).toBe(info.fp32.dtype);
  });

  it("includes every shared file regardless of quantized", () => {
    const info = modelInfoByName(DEFAULT_MODEL_NAME);
    if (!info) throw new Error("unreachable");
    for (const shared of info.sharedFiles) {
      expect(pinnedFilesFor(info, true).some((f) => f.path === shared.path)).toBe(true);
      expect(pinnedFilesFor(info, false).some((f) => f.path === shared.path)).toBe(true);
    }
  });

  it("every pinned file (shared + both onnx variants) has a 64-hex-char sha256 and a positive size", () => {
    for (const m of MODEL_CATALOG) {
      for (const f of [...m.sharedFiles, m.quantized.onnxFile, m.fp32.onnxFile]) {
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(f.sizeBytes).toBeGreaterThan(0);
      }
    }
  });

  // THE-1122 review: pins each catalog entry's pooling against its OWN model card's
  // 1_Pooling/config.json (verified directly, 2026-09-25) — a wrong value here silently produces
  // valid-looking but degraded vectors, which is exactly what happened to bge-small-en-v1.5 in the
  // first measurement (mean applied uniformly; its card is CLS).
  it("pins each catalog entry's pooling strategy against its own model card", () => {
    expect(modelInfoByName("all-MiniLM-L6-v2")?.pooling).toBe("mean");
    expect(modelInfoByName("bge-small-en-v1.5")?.pooling).toBe("cls");
    expect(modelInfoByName("nomic-embed-text-v1.5")?.pooling).toBe("mean");
  });
});
