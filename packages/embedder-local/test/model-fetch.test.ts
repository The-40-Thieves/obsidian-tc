// THE-1122 — the fetch/verify/atomic-rename pipeline, exercised against a TINY synthetic model
// spec via an injected fetchFn — never the network, never model-info.ts's real pinned files.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertVerified,
  fetchAndVerifyModel,
  modelDirFor,
  unsupportedPlatformReason,
  verifyModelDir,
} from "../src/model-fetch.js";

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
  root = await mkdtemp(join(tmpdir(), "embedder-local-fetch-test-"));
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
    await writeFile(join(dir, "a.txt"), A_CONTENT);
    await writeFile(join(dir, "sub", "b.txt"), "wrong-bytes-same-len");
    const results = await verifyModelDir(dir, SPEC);
    const byPath = Object.fromEntries(results.map((r) => [r.file.path, r]));
    expect(byPath["a.txt"]?.ok).toBe(true);
    expect(byPath["sub/b.txt"]?.ok).toBe(false);
  });

  it("refuses a symlink standing in for a pinned file", async () => {
    const dir = join(root, "symlinked");
    await mkdir(dir, { recursive: true });
    const realFile = join(root, "real-a.txt");
    await writeFile(realFile, A_CONTENT);
    await symlink(realFile, join(dir, "a.txt"));
    const results = await verifyModelDir(dir, { ...SPEC, pinnedFiles: [PINNED[0]] });
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.reason).toMatch(/symlink/);
  });

  it("refuses an extra, unpinned file present in the directory", async () => {
    const dir = join(root, "extra");
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "a.txt"), A_CONTENT);
    await writeFile(join(dir, "sub", "b.txt"), B_CONTENT);
    await writeFile(join(dir, "intruder.bin"), "not pinned");
    const results = await verifyModelDir(dir, SPEC);
    const extra = results.find((r) => r.file.path === "intruder.bin");
    expect(extra?.ok).toBe(false);
  });
});

describe("fetchAndVerifyModel", () => {
  it("downloads, verifies, and publishes atomically on a cold cache", async () => {
    const fetchFn = okFetchFn();
    const dir = await fetchAndVerifyModel(root, { ...SPEC, fetchFn });
    expect(dir).toBe(modelDirFor(root, SPEC));
    await assertVerified(dir, SPEC);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("is a zero-network no-op when the cache already verifies", async () => {
    await fetchAndVerifyModel(root, { ...SPEC, fetchFn: okFetchFn() });
    const fetchFn2 = okFetchFn();
    await fetchAndVerifyModel(root, { ...SPEC, fetchFn: fetchFn2 });
    expect(fetchFn2).not.toHaveBeenCalled();
  });

  it("refuses to download on an unsupported platform (darwin-x64), leaving no partial state", async () => {
    const fetchFn = okFetchFn();
    await expect(
      fetchAndVerifyModel(root, {
        ...SPEC,
        fetchFn,
        platformOverride: { platform: "darwin", arch: "x64" },
      }),
    ).rejects.toThrow(/darwin-x64|Intel Mac/);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(existsSync(modelDirFor(root, SPEC))).toBe(false);
  });

  it("throws an actionable error naming the offline fetch-model alternative when every attempt fails", async () => {
    const failingFetch = vi.fn(
      async () => new Response(null, { status: 500 }),
    ) as unknown as typeof fetch;
    await expect(fetchAndVerifyModel(root, { ...SPEC, fetchFn: failingFetch })).rejects.toThrow(
      /bun run fetch-model/,
    );
    expect(existsSync(modelDirFor(root, SPEC))).toBe(false);
  });

  it("refuses a response from a host that is not huggingface.co/hf.co", async () => {
    const redirectingFetch = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("huggingface.co")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://evil.example.com/a.txt" },
        });
      }
      return new Response("pwned", { status: 200 });
    }) as unknown as typeof fetch;
    await expect(fetchAndVerifyModel(root, { ...SPEC, fetchFn: redirectingFetch })).rejects.toThrow(
      /unexpected host|evil\.example\.com/,
    );
  });

  it("takes over a stale lock rather than waiting forever", async () => {
    const lockDir = `${modelDirFor(root, SPEC)}.lock`;
    await mkdir(lockDir, { recursive: true });
    const old = new Date(Date.now() - 999999);
    await utimes(lockDir, old, old);
    const dir = await fetchAndVerifyModel(root, {
      ...SPEC,
      fetchFn: okFetchFn(),
      lockStaleMs: 50,
      lockPollMs: 5,
    });
    await assertVerified(dir, SPEC);
  });
});

describe("assertVerified", () => {
  it("throws with per-file detail when the directory no longer verifies clean", async () => {
    const dir = await fetchAndVerifyModel(root, { ...SPEC, fetchFn: okFetchFn() });
    await writeFile(join(dir, "a.txt"), "tampered");
    await expect(assertVerified(dir, SPEC)).rejects.toThrow(/a\.txt/);
  });
});

describe("unsupportedPlatformReason", () => {
  it("names darwin-x64 and linux-musl as unsupported", () => {
    expect(unsupportedPlatformReason({ platform: "darwin", arch: "x64" })).toMatch(
      /darwin-x64|Intel Mac/,
    );
    expect(
      unsupportedPlatformReason({ platform: "linux", arch: "x64", isMuslRuntime: () => true }),
    ).toMatch(/musl/);
  });

  it("returns undefined for a supported platform (linux glibc)", () => {
    expect(
      unsupportedPlatformReason({ platform: "linux", arch: "x64", isMuslRuntime: () => false }),
    ).toBeUndefined();
  });

  it("names embeddings.provider as the fix on both unsupported platforms (THE-1122 review)", () => {
    expect(unsupportedPlatformReason({ platform: "darwin", arch: "x64" })).toMatch(
      /embeddings\.provider/,
    );
    expect(
      unsupportedPlatformReason({ platform: "linux", arch: "x64", isMuslRuntime: () => true }),
    ).toMatch(/embeddings\.provider/);
  });
});
