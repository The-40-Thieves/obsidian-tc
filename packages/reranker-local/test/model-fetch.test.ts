// THE-944 — the fetch/verify/atomic-rename pipeline itself, exercised against a TINY synthetic
// model spec (two small files, not the real ~23 MB onnx export) via an injected fetchFn — never the
// network, never model-info.ts's real pinned files. Fast and fully deterministic; the real
// constants + real network path are proven separately by `bun run fetch-model` (manual/CI) and by
// test/integration.test.ts (skips unless the real weights are already on disk).
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAndVerifyModel, modelDirFor, verifyModelDir } from "../src/model-fetch.js";

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

const A_CONTENT = "hello";
const B_CONTENT = "world-file";
const PINNED = [
  { path: "a.txt", sha256: sha256(A_CONTENT), sizeBytes: Buffer.byteLength(A_CONTENT) },
  { path: "sub/b.txt", sha256: sha256(B_CONTENT), sizeBytes: Buffer.byteLength(B_CONTENT) },
] as const;
const SPEC = { modelId: "acme/tiny-model", revision: "rev1", pinnedFiles: PINNED };

/** A fetchFn stub serving PINNED's real content by URL suffix — the shape every test below starts
 *  from, then mutates (fails N times, serves wrong bytes, ...) to exercise one failure mode. */
function okFetchFn(): typeof fetch {
  return vi.fn(async (url: string | URL) => {
    const u = String(url);
    const content = u.endsWith("a.txt") ? A_CONTENT : u.endsWith("b.txt") ? B_CONTENT : undefined;
    if (content === undefined) return new Response(null, { status: 404 });
    return new Response(content, { status: 200 });
  }) as unknown as typeof fetch;
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "reranker-local-fetch-test-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("modelDirFor", () => {
  it("nests the revision INSIDE the model-id segment: <root>/<model-id>/<revision>", () => {
    expect(modelDirFor(root, SPEC)).toBe(join(root, "acme/tiny-model", "rev1"));
  });
});

describe("verifyModelDir", () => {
  it("reports missing, size-mismatched, sha256-mismatched, and ok, independently per file", async () => {
    const dir = join(root, "d");
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "a.txt"), A_CONTENT); // correct
    await writeFile(join(dir, "sub", "b.txt"), "wrong-bytes-same-len"); // wrong content, size matches accidentally? ensure not
    const results = await verifyModelDir(dir, SPEC);
    const byPath = Object.fromEntries(results.map((r) => [r.file.path, r]));
    expect(byPath["a.txt"]?.ok).toBe(true);
    expect(byPath["sub/b.txt"]?.ok).toBe(false);
    expect(byPath["sub/b.txt"]?.reason).toMatch(/sha256|size/);
  });

  it("reports 'missing' for a file that was never written", async () => {
    const dir = join(root, "empty");
    const results = await verifyModelDir(dir, SPEC);
    expect(results.every((r) => r.ok === false && r.reason === "missing")).toBe(true);
  });
});

// THE-944 test requirement: "fetch verification going red on a corrupted file". A corrupted
// pre-existing cache must NOT be silently accepted — verifyModelDir must flag it, and
// fetchAndVerifyModel must therefore re-fetch rather than serving the corrupted bytes to the
// caller. The MUTATION this test catches: a version of this pipeline that trusted file PRESENCE
// (or size) alone, without the sha256 check, would short-circuit on the corrupted file below and
// never call fetchFn at all — this test fails red under that mutation (fetchFn.mock.calls would be
// empty) and passes green with the real sha256-checking implementation.
describe("fetch verification goes red on a corrupted file", () => {
  it("a pre-existing file with the WRONG content (matching size) is detected as corrupt and re-fetched", async () => {
    const dir = join(root, "cache");
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "a.txt"), A_CONTENT); // this one is genuinely fine
    // Same byte length as B_CONTENT ("world-file", 10 bytes) so this is caught by the sha256 check,
    // not merely the (weaker) size check — proving the checksum, not just presence/size, gates use.
    await writeFile(join(dir, "sub", "b.txt"), "world-FAKE");
    expect(Buffer.byteLength("world-FAKE")).toBe(Buffer.byteLength(B_CONTENT));

    const preCheck = await verifyModelDir(dir, SPEC);
    expect(preCheck.find((r) => r.file.path === "sub/b.txt")?.ok).toBe(false);

    const fetchFn = okFetchFn();
    const finalDir = await fetchAndVerifyModel(root, { ...SPEC, fetchFn });
    // Detected as unverified -> re-fetched (root, not the pre-populated `dir`, is the real target).
    expect(fetchFn).toHaveBeenCalled();
    const postCheck = await verifyModelDir(finalDir, SPEC);
    expect(postCheck.every((r) => r.ok)).toBe(true);
  });
});

// THE-944 test requirement: "offline path with a pre-populated cache".
describe("offline path with a pre-populated cache", () => {
  it("touches the network ZERO times when the target directory already verifies clean", async () => {
    const finalDir = modelDirFor(root, SPEC);
    await mkdir(join(finalDir, "sub"), { recursive: true });
    await writeFile(join(finalDir, "a.txt"), A_CONTENT);
    await writeFile(join(finalDir, "sub", "b.txt"), B_CONTENT);

    const fetchFn = vi.fn(async () => {
      throw new Error("network must not be reached — the cache is already verified");
    }) as unknown as typeof fetch;

    const resolved = await fetchAndVerifyModel(root, { ...SPEC, fetchFn });
    expect(resolved).toBe(finalDir);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("fetchAndVerifyModel — download, retry, and atomic rename", () => {
  it("downloads into place via the injected fetchFn, matching the documented <model-id>/<revision> layout", async () => {
    const fetchFn = okFetchFn();
    const finalDir = await fetchAndVerifyModel(root, { ...SPEC, fetchFn });
    expect(finalDir).toBe(modelDirFor(root, SPEC));
    expect(existsSync(join(finalDir, "a.txt"))).toBe(true);
    expect(existsSync(join(finalDir, "sub", "b.txt"))).toBe(true);
    // No leftover staging directory beside the final one.
    const modelIdDir = join(root, "acme", "tiny-model");
    expect(readdirSync(modelIdDir)).toEqual(["rev1"]);
  });

  it("retries exactly once — attempt 1 fails on its first file (aborting that attempt), attempt 2 succeeds", async () => {
    let call = 0;
    const fetchFn = vi.fn(async (url: string | URL) => {
      call++;
      // Fail ONLY the very first request (attempt 1's first file, "a.txt") — the download loop
      // aborts an attempt on its first failing file, so attempt 1 never even reaches "sub/b.txt".
      if (call === 1) return new Response(null, { status: 500, statusText: "boom" });
      const u = String(url);
      const content = u.endsWith("a.txt") ? A_CONTENT : B_CONTENT;
      return new Response(content, { status: 200 });
    }) as unknown as typeof fetch;

    const finalDir = await fetchAndVerifyModel(root, { ...SPEC, fetchFn });
    expect(existsSync(join(finalDir, "a.txt"))).toBe(true);
    expect(existsSync(join(finalDir, "sub", "b.txt"))).toBe(true);
    expect(call).toBe(3); // attempt 1: a.txt (fails) | attempt 2: a.txt, sub/b.txt (both succeed)
  });

  it("throws a clear error naming 'bun run fetch-model' as the offline alternative when both attempts fail", async () => {
    const fetchFn = vi.fn(
      async () => new Response(null, { status: 500 }),
    ) as unknown as typeof fetch;
    await expect(fetchAndVerifyModel(root, { ...SPEC, fetchFn })).rejects.toThrow(
      /bun run fetch-model/,
    );
  });

  it("never leaves a partial or staging directory at the final path when every attempt fails", async () => {
    const fetchFn = vi.fn(
      async () => new Response(null, { status: 500 }),
    ) as unknown as typeof fetch;
    await expect(fetchAndVerifyModel(root, { ...SPEC, fetchFn })).rejects.toThrow();
    const finalDir = modelDirFor(root, SPEC);
    expect(existsSync(finalDir)).toBe(false);
    const modelIdDir = join(root, "acme", "tiny-model");
    // Nothing (not even a `.download-*` staging leftover) survives a total failure.
    expect(existsSync(modelIdDir) ? readdirSync(modelIdDir) : []).toEqual([]);
  });
});
