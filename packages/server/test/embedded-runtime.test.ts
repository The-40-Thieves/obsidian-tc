// The standalone binary carries the local embedder inside itself (scripts/build-binary.ts):
// embeddings/embedded-runtime.ts unpacks its onnxruntime native files, and the "local" resolver
// tries that embedded route before the package lookup. The real compiled path is proven by the
// first-run matrix's binary cells; this pins the two pieces that do not need a binary.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, it, vi } from "vitest";
import { extractEmbeddedRuntime } from "../src/embeddings/embedded-runtime";
import { resolveLocalEmbedderModule } from "../src/providers/local-embedder-registry";
import { makeTempDir, rmTemp } from "./tmp";

const embedded = vi.hoisted(() => ({
  spec: undefined as undefined | { files: unknown[]; load: () => Promise<unknown> },
}));
vi.mock("../src/embeddings/embedded-embedder", () => ({
  get embeddedEmbedder() {
    return embedded.spec;
  },
}));

const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

describe("extractEmbeddedRuntime", () => {
  const root = makeTempDir("obtc-embedded-runtime-");
  afterAll(() => rmTemp(root));

  function asset(name: string, content: string): { name: string; asset: string; sha256: string } {
    const bytes = Buffer.from(content);
    const gz = join(root, `${name}.gz`);
    writeFileSync(gz, gzipSync(bytes));
    return { name, asset: gz, sha256: sha(bytes) };
  }

  it("unpacks every file into a content-keyed directory under <cacheDir>/runtime", () => {
    const files = [
      asset("onnxruntime_binding.node", "binding"),
      asset("libonnxruntime.so.1", "lib"),
    ];
    const dir = extractEmbeddedRuntime({ cacheDir: join(root, "c1"), files });
    expect(dir.startsWith(join(root, "c1", "runtime", "onnxruntime-"))).toBe(true);
    expect(readFileSync(join(dir, "onnxruntime_binding.node"), "utf8")).toBe("binding");
    expect(readFileSync(join(dir, "libonnxruntime.so.1"), "utf8")).toBe("lib");
  });

  it("reuses a verified cache and replaces a tampered file", () => {
    const files = [asset("lib.so", "genuine")];
    const cacheDir = join(root, "c2");
    const dir = extractEmbeddedRuntime({ cacheDir, files });
    const target = join(dir, "lib.so");
    // A second call with an intact file does not rewrite it.
    const before = readFileSync(target);
    expect(extractEmbeddedRuntime({ cacheDir, files })).toBe(dir);
    expect(readFileSync(target).equals(before)).toBe(true);
    // A file whose bytes no longer match the embedded hash is replaced, never loaded as-is.
    writeFileSync(target, "tampered");
    extractEmbeddedRuntime({ cacheDir, files });
    expect(readFileSync(target, "utf8")).toBe("genuine");
    // No staging file is left beside it.
    expect(existsSync(`${target}.${process.pid}.tmp`)).toBe(false);
  });

  it("refuses an embedded asset that does not match its recorded checksum", () => {
    const f = asset("bad.so", "payload");
    expect(() =>
      extractEmbeddedRuntime({
        cacheDir: join(root, "c3"),
        files: [{ ...f, sha256: sha(Buffer.from("something else")) }],
      }),
    ).toThrow(/does not match its recorded checksum/);
  });
});

describe("resolveLocalEmbedderModule: the embedded route", () => {
  const failImport = async (): Promise<never> => {
    throw new Error("package lookup must not be needed");
  };
  const ortDirKey = Symbol.for("obsidian-tc.ort-dir");
  const cacheRoot = makeTempDir("obtc-embedded-route-");
  afterAll(() => rmTemp(cacheRoot));

  it("unpacks the runtime, points the loader at it, then loads the embedder", async () => {
    const bytes = Buffer.from("binding");
    const gz = join(cacheRoot, "binding.gz");
    writeFileSync(gz, gzipSync(bytes));
    const mod = { createEmbeddingProvider: () => ({}) };
    const load = vi.fn(async () => mod);
    embedded.spec = { files: [{ name: "b.node", asset: gz, sha256: sha(bytes) }], load };
    try {
      const r = await resolveLocalEmbedderModule({}, { cacheDir: cacheRoot }, failImport);
      expect(r.ok).toBe(true);
      expect(r.mod).toBe(mod);
      expect(r.attempts).toEqual([
        { route: "embedded", target: "@the-40-thieves/obsidian-tc-embedder-local", ok: true },
      ]);
      const dir = (globalThis as Record<symbol, unknown>)[ortDirKey] as string;
      expect(dir.startsWith(join(cacheRoot, "runtime", "onnxruntime-"))).toBe(true);
      expect(readFileSync(join(dir, "b.node"), "utf8")).toBe("binding");
      expect(load).toHaveBeenCalledTimes(1);
    } finally {
      embedded.spec = undefined;
      delete (globalThis as Record<symbol, unknown>)[ortDirKey];
    }
  });

  it("records a failed embedded load and falls through to the package lookup", async () => {
    embedded.spec = {
      files: [],
      load: async () => {
        throw new Error("load failed");
      },
    };
    try {
      const mod = { createEmbeddingProvider: () => ({}) };
      const r = await resolveLocalEmbedderModule({}, { cacheDir: cacheRoot }, async () => mod);
      expect(r.ok).toBe(true);
      expect(r.attempts.map((a) => [a.route, a.ok])).toEqual([
        ["embedded", false],
        ["bare-specifier", true],
      ]);
      expect(r.attempts[0]?.error).toBe("load failed");
    } finally {
      embedded.spec = undefined;
      delete (globalThis as Record<symbol, unknown>)[ortDirKey];
    }
  });

  it("is skipped entirely outside a compiled binary (the placeholder is undefined)", async () => {
    const r = await resolveLocalEmbedderModule({}, {}, async () => ({}));
    expect(r.attempts.map((a) => a.route)).toEqual(["bare-specifier"]);
  });
});
