// Intel macOS (darwin-x64) WASM fallback, see src/onnx-wasm-fallback.ts. The platform and the native
// loader are injected, so this runs on any host. The transformers entry is a stub that reaches
// onnxruntime-node the way transformers' own Node branch does.
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureOnnxBackend } from "../src/onnx-wasm-fallback.js";

const STUB = fileURLToPath(new URL("./fixtures/transformers-entry-stub.mjs", import.meta.url));
const stubRequire = createRequire(STUB);
const resolved = stubRequire.resolve("onnxruntime-node");
const cache = createRequire(import.meta.url).cache as Record<string, unknown>;
const darwinX64 = { platform: "darwin" as const, arch: "x64" };
const noBinding = (): never => {
  throw new Error("Cannot find module '../bin/napi-v6/darwin/x64/onnxruntime_binding.node'");
};

interface WebOrt {
  env: { wasm: { wasmPaths: { mjs: string; wasm: string }; wasmBinary: ArrayBuffer } };
}

describe("ensureOnnxBackend", () => {
  beforeEach(() => {
    delete cache[resolved];
  });
  afterEach(() => {
    delete cache[resolved];
  });

  it("native load fails on darwin-x64: primes the cache with onnxruntime-web and sets its WASM paths and binary", async () => {
    const log = vi.fn();
    const result = await ensureOnnxBackend({
      ...darwinX64,
      transformersEntry: STUB,
      loadNative: noBinding,
      log,
    });
    expect(result.backend).toBe("wasm");
    const web = stubRequire("onnxruntime-web") as WebOrt;
    expect(cache[resolved]).toMatchObject({ exports: web });
    expect(web.env.wasm.wasmPaths.wasm).toMatch(/ort-wasm-simd-threaded\.wasm$/);
    expect(web.env.wasm.wasmPaths.mjs).toMatch(/ort-wasm-simd-threaded\.mjs$/);
    expect(web.env.wasm.wasmBinary.byteLength).toBeGreaterThan(0);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("the transformers entry's own onnxruntime-node require gets the web runtime", async () => {
    await ensureOnnxBackend({
      ...darwinX64,
      transformersEntry: STUB,
      loadNative: noBinding,
      log: () => {},
    });
    const stub = (await import(pathToFileURL(STUB).href)) as { ort: unknown };
    expect(stub.ort).toBe(stubRequire("onnxruntime-web"));
  });

  it("a second call on the same host is quiet: the primed entry is recognised", async () => {
    const log = vi.fn();
    const opts = { ...darwinX64, transformersEntry: STUB, loadNative: noBinding, log };
    await ensureOnnxBackend(opts);
    const again = await ensureOnnxBackend(opts);
    expect(again.backend).toBe("wasm");
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("native load succeeds on darwin-x64: returns native and leaves the cache untouched", async () => {
    const log = vi.fn();
    const result = await ensureOnnxBackend({
      ...darwinX64,
      transformersEntry: STUB,
      loadNative: () => ({ native: true }),
      log,
    });
    expect(result).toEqual({ backend: "native" });
    expect(cache[resolved]).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });

  it("returns the bundled wasm backend when transformers cannot be resolved outside node_modules", async () => {
    await expect(
      ensureOnnxBackend({
        ...darwinX64,
        resolveTransformersEntry: () => {
          throw new Error(
            "Cannot find package '@huggingface/transformers' imported from /bundle/index.mjs",
          );
        },
        log: () => {},
      }),
    ).resolves.toMatchObject({ backend: "wasm" });
  });

  it.each([
    ["linux", "x64"],
    ["linux", "arm64"],
    ["darwin", "arm64"],
    ["win32", "x64"],
  ] as const)("%s-%s is untouched: no native probe, no priming, no log", async (platform, arch) => {
    const loadNative = vi.fn(noBinding);
    const log = vi.fn();
    const result = await ensureOnnxBackend({
      platform,
      arch,
      transformersEntry: STUB,
      loadNative,
      log,
    });
    expect(result).toEqual({ backend: "native" });
    expect(loadNative).not.toHaveBeenCalled();
    expect(cache[resolved]).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });
});
