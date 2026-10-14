import { createRequire } from "node:module";
import { dirname } from "node:path";

const basePackage = "@the-40-thieves/obsidian-tc-embedder-local";
const runtimePackage = `${basePackage}-${process.platform}-${process.arch}`;
const ortDirKey = Symbol.for("obsidian-tc.ort-dir");

if (globalThis[ortDirKey] === undefined) {
  try {
    globalThis[ortDirKey] = dirname(
      createRequire(import.meta.url).resolve(`${runtimePackage}/package.json`),
    );
  } catch (cause) {
    const error = new Error(
      `The required ONNX runtime package ${runtimePackage} is missing. This usually means the install used --omit=optional/--no-optional, or no runtime is published for this platform (for example, musl).`,
      { cause },
    );
    error.code = "OBTC_EMBEDDER_RUNTIME_MISSING";
    throw error;
  }
}

const mod = await import("./embedder.mjs");

export const createEmbeddingProvider = mod.createEmbeddingProvider;
export const defaultModelsDir = mod.defaultModelsDir;
export const weightsPresent = mod.weightsPresent;
export const configureTransformersEnvForOnnxBackend = mod.configureTransformersEnvForOnnxBackend;
export const embedPipelineOptions = mod.embedPipelineOptions;
export const unsupportedPlatformReason = mod.unsupportedPlatformReason;
export const catalogModelNames = mod.catalogModelNames;
export const DEFAULT_MODEL_NAME = mod.DEFAULT_MODEL_NAME;
export const modelInfoByName = mod.modelInfoByName;
