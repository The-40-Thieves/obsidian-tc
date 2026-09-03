// THE-944 — shared verified-download machinery for the pinned cross-encoder weights. ONE place
// owns "download, verify against model-info.ts, atomic rename" so the two consumers can never
// drift on what "verified" means:
//   * src/index.ts's loadSession — the provider's own first-use lazy fetch (THE-944).
//   * scripts/fetch-model.mjs — the manual/offline/CI alternative (THE-705), now a thin CLI wrapper
//     around this module.
//
// Deliberately NOT imported by model-info.ts or index.ts at top level in a way that would reach the
// network at import time — this module's exports only touch the network when actually CALLED (see
// index.ts's header comment on why that invariant matters for the cold-start perf gate).
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MODEL_ID, MODEL_REVISION, PINNED_FILES, type PinnedFile } from "./model-info.js";

export interface FileVerifyResult {
  file: PinnedFile;
  ok: boolean;
  reason?: string;
}

/** Every production caller uses the real pinned constants and the platform `fetch`. Tests inject a
 *  tiny synthetic model spec + a stubbed `fetchFn` so the WHOLE pipeline (download, verify, atomic
 *  rename, one retry) is exercisable fast and deterministically, without touching the network or
 *  the real ~23 MB onnx file — the same injection idiom providers/registry.ts's
 *  `resolveLocalRerankerModule` and `buildLocalReranker` already use for their own real ladders. */
export interface ModelFetchSpec {
  modelId?: string;
  revision?: string;
  pinnedFiles?: readonly PinnedFile[];
  fetchFn?: typeof fetch;
}

interface ResolvedSpec {
  modelId: string;
  revision: string;
  pinnedFiles: readonly PinnedFile[];
  fetchFn: typeof fetch;
}

function resolveSpec(spec: ModelFetchSpec = {}): ResolvedSpec {
  return {
    modelId: spec.modelId ?? MODEL_ID,
    revision: spec.revision ?? MODEL_REVISION,
    pinnedFiles: spec.pinnedFiles ?? PINNED_FILES,
    fetchFn: spec.fetchFn ?? fetch,
  };
}

async function sha256File(path: string): Promise<string> {
  const buf = await readFile(path);
  return createHash("sha256").update(buf).digest("hex");
}

/** Checks every pinned file's presence, size, and sha256 under `modelDir` (the REVISION-scoped
 *  directory — see `modelDirFor`). Read-only, no network. Shared by the doctor-facing
 *  `bun run fetch-model --check` path and this module's own "is a re-download needed" check. */
export async function verifyModelDir(
  modelDir: string,
  spec: ModelFetchSpec = {},
): Promise<FileVerifyResult[]> {
  const { pinnedFiles } = resolveSpec(spec);
  const results: FileVerifyResult[] = [];
  for (const f of pinnedFiles) {
    const p = join(modelDir, f.path);
    if (!existsSync(p)) {
      results.push({ file: f, ok: false, reason: "missing" });
      continue;
    }
    const size = statSync(p).size;
    if (size !== f.sizeBytes) {
      results.push({ file: f, ok: false, reason: `size ${size} != expected ${f.sizeBytes}` });
      continue;
    }
    const digest = await sha256File(p);
    if (digest !== f.sha256) {
      results.push({ file: f, ok: false, reason: `sha256 ${digest} != expected ${f.sha256}` });
      continue;
    }
    results.push({ file: f, ok: true });
  }
  return results;
}

/** THE-944: the REVISION-scoped model directory under a `localModelPath` root —
 *  `<root>/<MODEL_ID>/<MODEL_REVISION>/`. Nesting the revision INSIDE the model-id segment (rather
 *  than the other way round) is deliberate, not incidental: this exact directory is what index.ts
 *  hands to `@huggingface/transformers`'s `from_pretrained` as `path_or_repo_id` — Transformers.js's
 *  own resource resolver (`buildResourcePaths` in its `utils/hub.js`) treats a `path_or_repo_id`
 *  that fails its `REPO_ID_REGEX` (anything with more than one `/`) as a literal directory rather
 *  than a Hub id, and reads `<path_or_repo_id>/<filename>` directly — env.localModelPath is never
 *  consulted for such a path. That is what lets this directory be revision-isolated (a future
 *  MODEL_REVISION bump gets its own directory, never silently serving stale files) while still
 *  resolving correctly through the library's real, verified-against-source path-join contract.
 *  Verified end-to-end against the real @huggingface/transformers 4.2.0 package (not just read from
 *  its source) — see test/integration.test.ts, which loads the real tokenizer+model this way. */
export function modelDirFor(root: string, spec: ModelFetchSpec = {}): string {
  const { modelId, revision } = resolveSpec(spec);
  return join(root, modelId, revision);
}

async function downloadFile(fetchFn: typeof fetch, url: string, destPath: string): Promise<void> {
  await mkdir(dirname(destPath), { recursive: true });
  const res = await fetchFn(url);
  if (!res.ok || !res.body) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(destPath);
    // node fetch's Response.body is a web ReadableStream; piped via the async iterator to keep this
    // module's only dependency the Node std lib (same reasoning as the original fetch-model.mjs).
    (async () => {
      try {
        for await (const chunk of res.body as AsyncIterable<Uint8Array>) out.write(chunk);
        out.end();
      } catch (e) {
        reject(e);
      }
    })();
    out.on("finish", resolve);
    out.on("error", reject);
  });
}

/** Downloads every pinned file into a fresh TEMP directory beside `finalDir`, verifies the WHOLE
 *  batch, and only then renames the temp directory over `finalDir` in one `rename()` call —
 *  `finalDir` therefore only ever transitions from "previous state" to "fully verified new state";
 *  no reader can ever observe a partially-downloaded set of files at the real path. One retry (a
 *  second, fresh temp dir) before giving up — deliberately whole-batch rather than per-file: this
 *  model is one ~23 MB file plus five small ones, so re-fetching everything on any single failure
 *  trades a little bandwidth for never having to reason about a half-good, half-bad directory. */
async function downloadAndVerifyInto(finalDir: string, resolved: ResolvedSpec): Promise<void> {
  const { modelId, revision, pinnedFiles, fetchFn } = resolved;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const tmpDir = `${finalDir}.download-${process.pid}-${Date.now()}-${attempt}`;
    try {
      for (const f of pinnedFiles) {
        const url = `https://huggingface.co/${modelId}/resolve/${revision}/${f.path}`;
        await downloadFile(fetchFn, url, join(tmpDir, f.path));
      }
      const results = await verifyModelDir(tmpDir, { pinnedFiles });
      const bad = results.filter((r) => !r.ok);
      if (bad.length > 0) {
        throw new Error(
          `${bad.length}/${results.length} pinned files failed verification after download: ` +
            bad.map((r) => `${r.file.path} (${r.reason})`).join(", "),
        );
      }
      // Clear a stale finalDir first: rename() over an existing non-empty directory fails on every
      // platform this repo targets. A stale finalDir only exists here if it previously verified
      // incomplete (see fetchAndVerifyModel below — a clean-verified finalDir short-circuits before
      // this function is ever called).
      await rm(finalDir, { recursive: true, force: true });
      await mkdir(dirname(finalDir), { recursive: true });
      await rename(tmpDir, finalDir);
      return;
    } catch (e) {
      lastError = e;
      await rm(tmpDir, { recursive: true, force: true });
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** THE-944: the provider's first-use fetch — called from index.ts's `loadSession`, on the first
 *  `rerank()` call only (never at import time). `root` is whatever `localModelPath` resolved to
 *  (this package's own `models/` directory by default, or an operator's `reranker.localModelPath`
 *  override). Already-verified files are left untouched — this is the fast, common-case,
 *  zero-network path once the weights are cached. A failed fetch/verify is retried once; a second
 *  failure throws an error naming `bun run fetch-model` (this package's manual script) as the
 *  offline alternative — pre-populate the SAME directory from a machine with network access. */
export async function fetchAndVerifyModel(
  root: string,
  spec: ModelFetchSpec = {},
): Promise<string> {
  const resolved = resolveSpec(spec);
  const finalDir = modelDirFor(root, spec);
  const existing = await verifyModelDir(finalDir, spec);
  if (existing.length > 0 && existing.every((r) => r.ok)) return finalDir;
  try {
    await downloadAndVerifyInto(finalDir, resolved);
  } catch (e) {
    throw new Error(
      `reranker-local: could not fetch/verify the pinned model weights (${resolved.modelId}@${resolved.revision}) ` +
        `into "${finalDir}": ${e instanceof Error ? e.message : String(e)}. Offline alternative: on a ` +
        `machine with network access, run "bun run fetch-model" in packages/reranker-local (or ` +
        `"bun run fetch-model --dir <path>" for a non-default root matching reranker.localModelPath), ` +
        "then ship or mount that directory here.",
    );
  }
  return finalDir;
}
