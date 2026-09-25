// THE-1122 — verified-download machinery for the pinned embedding model weights, used by both
// index.ts's loadSession and scripts/fetch-model.mjs so they can't drift on what "verified" means.
//
// This is a DELIBERATE MIRROR of packages/reranker-local/src/model-fetch.ts (THE-944/THE-1079), not
// an import from it: reranker-local is a pre-existing, independently-published, independently-gated
// package this ticket does not otherwise touch, and it is (by its own README) NOT a root workspace
// member specifically so its ~230MB @huggingface/transformers dependency stays opt-in — pulling this
// package's logic FROM it would make embedder-local depend on reranker-local, inverting the
// resolution direction packages/server's registry.ts expects (server -> dynamically resolves EACH of
// these optional packages independently; neither optional package may depend on the other or on
// packages/server). A shared `packages/shared` home was considered and rejected: that package is
// deliberately isomorphic (no Node types — see its net-host.ts, which avoids `node:net` for exactly
// this reason) so it stays usable from a browser/Obsidian-plugin context, and this module is
// inherently Node-fs- and network-shaped. This repo already has a documented precedent for exactly
// this situation — reranker-local's own `unsupportedPlatformReason` duplicates (rather than imports)
// packages/server's `onnxNativePrebuildStatus` with an explicit "keep both in sync" comment. Same
// call here: mirror, don't share. If this logic changes, change it in both packages.
//
// Not imported anywhere in a way that reaches the network at import time — only when CALLED.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, type Dirent } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  dtypeFor,
  type EmbeddingModelInfo,
  type PinnedFile,
  pinnedFilesFor,
} from "./model-info.js";

/** Refuses a DOWNLOAD (never a read of already-verified files) on a platform with no
 *  onnxruntime-node native prebuild: linux x64/arm64 glibc, darwin arm64, win32 x64/arm64 only —
 *  musl and darwin-x64 have none. Duplicated, not imported, from packages/server's own
 *  `onnxNativePrebuildStatus` AND from packages/reranker-local's copy of the same check (this
 *  package stays dependency-free of both — keep all three in sync if the matrix changes). musl
 *  detection via `process.report`'s own `header.glibcVersionRuntime` (present on glibc, absent on
 *  musl) — not airtight against an unusual custom Node build. */
export function unsupportedPlatformReason(
  opts: { platform?: NodeJS.Platform; arch?: string; isMuslRuntime?: () => boolean } = {},
): string | undefined {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  if (platform === "darwin" && arch === "x64") {
    return (
      "this platform (darwin-x64 / Intel Mac) has NO onnxruntime-node prebuilt binary — the " +
      '"local" embedder cannot run here regardless of whether the pinned weights are fetched. ' +
      "Set embeddings.provider to a hosted or self-hosted backend instead (openai, voyage, " +
      "cohere, bge-m3, openai-compatible, ollama)."
    );
  }
  const isMuslRuntime =
    opts.isMuslRuntime ??
    (() => {
      try {
        // biome-ignore lint/suspicious/noExplicitAny: process.report's type is loosely typed upstream.
        const header = (process.report?.getReport() as any)?.header;
        return header !== undefined && header.glibcVersionRuntime === undefined;
      } catch {
        return false;
      }
    });
  if (platform === "linux" && isMuslRuntime()) {
    return (
      "this platform (linux musl libc, e.g. Alpine) has NO onnxruntime-node prebuilt binary — " +
      'the "local" embedder cannot run here regardless of whether the pinned weights are fetched. ' +
      "Set embeddings.provider to a hosted or self-hosted backend instead (openai, voyage, " +
      "cohere, bge-m3, openai-compatible, ollama)."
    );
  }
  return undefined;
}

export interface FileVerifyResult {
  file: PinnedFile;
  ok: boolean;
  reason?: string;
}

/** Every production caller uses a real catalog entry from model-info.ts and the platform `fetch`.
 *  Tests inject a tiny synthetic model spec + a stubbed `fetchFn` so the whole pipeline is
 *  exercisable fast and deterministically, without touching the network or the real ~20-35 MB onnx
 *  file. */
export interface ModelFetchSpec {
  modelId: string;
  revision: string;
  pinnedFiles: readonly PinnedFile[];
  fetchFn?: typeof fetch;
  /** Forwarded to `unsupportedPlatformReason`; real callers never set this. */
  platformOverride?: Parameters<typeof unsupportedPlatformReason>[0];
  /** How old a lock may be before a new fetcher takes it over instead of waiting (see
   *  `acquireLockOrObserveVerified`); real callers never set this. */
  lockStaleMs?: number;
  /** How long to sleep between lock-acquisition polls; real callers never set this. */
  lockPollMs?: number;
}

export function specFromModelInfo(info: EmbeddingModelInfo, quantized: boolean): ModelFetchSpec {
  return {
    modelId: info.modelId,
    revision: info.revision,
    pinnedFiles: pinnedFilesFor(info, quantized),
  };
}

export { dtypeFor };

interface ResolvedSpec {
  modelId: string;
  revision: string;
  pinnedFiles: readonly PinnedFile[];
  fetchFn: typeof fetch;
  lockStaleMs: number;
  lockPollMs: number;
}

// 10 minutes means "no heartbeat in 10 minutes" (a crashed/wedged holder), not "this file is
// unusually large" — a live downloader re-touches owner.json every LOCK_REFRESH_INTERVAL_MS (see
// startLockRefresh), so its observed lock age never approaches this regardless of nomic's ~547 MB
// fp32 export legitimately taking a slow connection past 10 minutes.
const DEFAULT_LOCK_STALE_MS = 10 * 60 * 1000;
const DEFAULT_LOCK_POLL_MS = 200;
// Well under DEFAULT_LOCK_STALE_MS, with jitter margin — see startLockRefresh.
const LOCK_REFRESH_INTERVAL_MS = 30 * 1000;

function resolveSpec(spec: ModelFetchSpec): ResolvedSpec {
  return {
    modelId: spec.modelId,
    revision: spec.revision,
    pinnedFiles: spec.pinnedFiles,
    fetchFn: spec.fetchFn ?? fetch,
    lockStaleMs: spec.lockStaleMs ?? DEFAULT_LOCK_STALE_MS,
    lockPollMs: spec.lockPollMs ?? DEFAULT_LOCK_POLL_MS,
  };
}

// Streamed via createReadStream, not readFile — nomic's ~547 MB fp32 export shouldn't be read
// whole into memory just to hash it. reranker-local's own copy stays readFile-based (its ~23 MB
// model makes the difference immaterial) — see DOCUMENTED_DELTAS in check-model-fetch-parity.mjs.
async function sha256File(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolvePromise(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/** Every relative entry present under `dir`, recursively. `readdir`'s `Dirent` classification
 *  reflects the entry itself (lstat-like), never a symlink's target, so a symlink is recorded as a
 *  leaf — never descended into, never mistaken for a real subdirectory. Missing `dir` -> empty
 *  list; `verifyModelDir` already reports that as "missing" per pinned file. */
async function listRelativeEntries(dir: string): Promise<{ rel: string; symlink: boolean }[]> {
  const out: { rel: string; symlink: boolean }[] = [];
  async function walk(sub: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(join(dir, sub), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = sub ? `${sub}/${e.name}` : e.name;
      if (e.isSymbolicLink()) {
        out.push({ rel, symlink: true });
      } else if (e.isDirectory()) {
        await walk(rel);
      } else {
        out.push({ rel, symlink: false });
      }
    }
  }
  await walk("");
  return out;
}

/** OS-generated housekeeping files (Finder's `.DS_Store`, Windows' `Thumbs.db`/`desktop.ini`),
 *  matched by BASENAME at any depth and ignored (not refused) so merely browsing an offline cache
 *  doesn't brick it. A small, EXACT allowlist, never wildcard/prefix — widening it would widen the
 *  gap the extraneous-entry check exists to close. Regular files only: a symlink borrowing a junk
 *  basename is still a symlink and is refused (see the `!symlink &&` guard where this is used). */
const IGNORED_OS_JUNK_BASENAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

function isIgnoredOsJunk(relPath: string): boolean {
  const basename = relPath.split("/").pop() ?? relPath;
  return IGNORED_OS_JUNK_BASENAMES.has(basename);
}

/** Checks every pinned file's presence, size, and sha256 under `modelDir` (the REVISION-scoped
 *  directory — see `modelDirFor`). Read-only, no network. Shared by `bun run fetch-model --check`
 *  and this module's own "is a re-download needed" check.
 *
 *  Hardened against a write-capable adversary on the cache directory: (1) `lstat`, never
 *  `stat`/`existsSync` — those FOLLOW symlinks, so a pinned filename could be swapped for a
 *  symlink pointing at arbitrary bytes while this still reports "verified"; a symlink is refused
 *  outright. (2) every entry present is compared against the exact pinned-file set — an EXTRA
 *  planted file (not overwriting a known name) is refused too. */
export async function verifyModelDir(
  modelDir: string,
  spec: ModelFetchSpec,
): Promise<FileVerifyResult[]> {
  const { pinnedFiles } = resolveSpec(spec);
  const results: FileVerifyResult[] = [];
  const expected = new Set(pinnedFiles.map((f) => f.path));
  for (const f of pinnedFiles) {
    const p = join(modelDir, f.path);
    let st: Awaited<ReturnType<typeof lstat>>;
    try {
      st = await lstat(p);
    } catch {
      results.push({ file: f, ok: false, reason: "missing" });
      continue;
    }
    if (st.isSymbolicLink()) {
      results.push({ file: f, ok: false, reason: "refused: symlink, not a regular file" });
      continue;
    }
    if (!st.isFile()) {
      results.push({
        file: f,
        ok: false,
        reason: `refused: not a regular file (${st.isDirectory() ? "directory" : "other"})`,
      });
      continue;
    }
    if (st.size !== f.sizeBytes) {
      results.push({ file: f, ok: false, reason: `size ${st.size} != expected ${f.sizeBytes}` });
      continue;
    }
    const digest = await sha256File(p);
    if (digest !== f.sha256) {
      results.push({ file: f, ok: false, reason: `sha256 ${digest} != expected ${f.sha256}` });
      continue;
    }
    results.push({ file: f, ok: true });
  }
  const present = await listRelativeEntries(modelDir);
  for (const { rel, symlink } of present) {
    if (expected.has(rel) || (!symlink && isIgnoredOsJunk(rel))) continue;
    results.push({
      file: { path: rel, sha256: "", sizeBytes: -1 },
      ok: false,
      reason: `refused: unexpected entry "${rel}" present (not one of the pinned files) — remove it from the model directory`,
    });
  }
  return results;
}

/** The REVISION-scoped model directory under a `localModelPath` root —
 *  `<root>/<modelId>/<revision>/`. The revision is nested INSIDE the model-id segment (not the
 *  other way round) because this exact directory is what index.ts hands to
 *  `@huggingface/transformers`'s `from_pretrained` as `path_or_repo_id` — Transformers.js's own
 *  resolver treats any `path_or_repo_id` with more than one `/` as a literal directory rather
 *  than a Hub id, reading `<path_or_repo_id>/<filename>` directly. */
export function modelDirFor(
  root: string,
  spec: Pick<ModelFetchSpec, "modelId" | "revision">,
): string {
  return join(root, spec.modelId, spec.revision);
}

/** True when every pinned file verifies clean AND at least one was checked (an empty pinned-files
 *  list is never "verified"). Shared by the lock's fast paths and the pre-publish re-check below. */
async function isVerified(dir: string, spec: ModelFetchSpec): Promise<boolean> {
  const results = await verifyModelDir(dir, spec);
  return results.length > 0 && results.every((r) => r.ok);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The cross-process lock directory for `finalDir` — a SIBLING path, never inside `finalDir`
// itself, so a lock can exist (or be taken over) independently of whatever state `finalDir` is in.
function lockDirFor(finalDir: string): string {
  return `${finalDir}.lock`;
}

interface LockOwner {
  pid: number;
  startedAt: number;
}

async function readLockOwner(lockDir: string): Promise<LockOwner | undefined> {
  try {
    const raw = await readFile(join(lockDir, "owner.json"), "utf8");
    const parsed = JSON.parse(raw) as Partial<LockOwner>;
    if (typeof parsed.pid === "number" && typeof parsed.startedAt === "number") {
      return { pid: parsed.pid, startedAt: parsed.startedAt };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** The lock's AGE for staleness, in ms — `owner.json`'s `startedAt` when it exists and parses,
 *  else the lock DIRECTORY's own mtime (a crash before the owner-file write lands leaves no
 *  owner.json; `mkdir` sets a fresh directory's mtime at creation, so this fallback is never
 *  younger than the lock actually is). `undefined` only when the lock directory is already gone —
 *  not stale, just moot. */
async function lockAgeMs(lockDir: string): Promise<number | undefined> {
  const owner = await readLockOwner(lockDir);
  if (owner) return Date.now() - owner.startedAt;
  try {
    const st = await lstat(lockDir);
    return Date.now() - st.mtimeMs;
  } catch {
    return undefined;
  }
}

// Temp-then-rename, same atomicity contract as the model files themselves (downloadAndVerifyInto)
// — a direct writeFile could leave a reader observing truncated JSON mid-write.
async function writeLockOwnerAtomic(lockDir: string, owner: LockOwner): Promise<void> {
  const finalPath = join(lockDir, "owner.json");
  const tmpPath = join(lockDir, `owner.json.tmp-${process.pid}-${Date.now()}`);
  await writeFile(tmpPath, JSON.stringify(owner));
  await rename(tmpPath, finalPath);
}

/** `mkdir` (non-recursive) is the exclusive-create primitive: it throws EEXIST if `lockDir`
 *  already exists and is atomic on every filesystem this repo targets, unlike a lockFILE opened
 *  with `wx` on some network filesystems. Returns false when another holder already has it. */
async function tryAcquireLock(finalDir: string): Promise<boolean> {
  const lockDir = lockDirFor(finalDir);
  await mkdir(dirname(lockDir), { recursive: true });
  try {
    await mkdir(lockDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
  await writeLockOwnerAtomic(lockDir, { pid: process.pid, startedAt: Date.now() });
  return true;
}

async function releaseLock(finalDir: string): Promise<void> {
  await rm(lockDirFor(finalDir), { recursive: true, force: true });
}

/** Keeps a held lock's observed age near zero for as long as a real download is progressing, by
 *  re-writing `owner.json`'s `startedAt` to "now" every LOCK_REFRESH_INTERVAL_MS — see that
 *  constant's comment for why this exists (a large fp32 model can legitimately take longer to
 *  download than DEFAULT_LOCK_STALE_MS). `unref()`'d so this timer alone never keeps the process
 *  alive; a failed refresh write is swallowed (best-effort heartbeat, not a correctness
 *  requirement — the LOCK_WAIT_DEADLINE_MULTIPLIER backstop in acquireLockOrObserveVerified still
 *  bounds a waiter even if every refresh in a run happened to fail). Returns a stop function the
 *  caller MUST call (via `finally`) once the download settles, successfully or not. */
function startLockRefresh(finalDir: string): () => void {
  const lockDir = lockDirFor(finalDir);
  const timer = setInterval(() => {
    writeLockOwnerAtomic(lockDir, { pid: process.pid, startedAt: Date.now() }).catch(
      () => undefined,
    );
  }, LOCK_REFRESH_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

// A waiter gives up after this many multiples of `lockStaleMs` and throws rather than polling
// forever — a backstop under the stale-takeover check for whatever `lockAgeMs` can't observe.
const LOCK_WAIT_DEADLINE_MULTIPLIER = 3;

async function acquireLockOrObserveVerified(
  finalDir: string,
  spec: ModelFetchSpec,
  resolved: ResolvedSpec,
): Promise<"acquired" | "already-verified"> {
  const lockDir = lockDirFor(finalDir);
  const deadlineAt = Date.now() + resolved.lockStaleMs * LOCK_WAIT_DEADLINE_MULTIPLIER;
  for (;;) {
    if (await isVerified(finalDir, spec)) return "already-verified";
    if (await tryAcquireLock(finalDir)) return "acquired";
    const age = await lockAgeMs(lockDir);
    if (age !== undefined && age > resolved.lockStaleMs) {
      await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
      continue; // retry acquisition immediately — already known stale, no need to sleep first
    }
    if (Date.now() >= deadlineAt) {
      throw new Error(
        `embedder-local: gave up waiting for the model-fetch lock at "${lockDir}" after ` +
          `${resolved.lockStaleMs * LOCK_WAIT_DEADLINE_MULTIPLIER}ms — it never verified as stale ` +
          "and was never released. If no other process is genuinely fetching this model, remove " +
          `that directory ("rm -rf ${lockDir}") and retry.`,
      );
    }
    await sleep(resolved.lockPollMs);
  }
}

/** Downloads every pinned file into a fresh TEMP directory beside `finalDir`, verifies the WHOLE
 *  batch, then renames the temp directory over `finalDir` in one `rename()` call — `finalDir` only
 *  ever transitions from "previous state" to "fully verified new state"; no reader observes a
 *  partial download. One retry (fresh temp dir) before giving up. */
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
      const results = await verifyModelDir(tmpDir, { modelId, revision, pinnedFiles });
      const bad = results.filter((r) => !r.ok);
      if (bad.length > 0) {
        throw new Error(
          `${bad.length}/${results.length} pinned files failed verification after download: ` +
            bad.map((r) => `${r.file.path} (${r.reason})`).join(", "),
        );
      }
      if (await isVerified(finalDir, { modelId, revision, pinnedFiles })) {
        await rm(tmpDir, { recursive: true, force: true });
        return;
      }
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

/** THE REDIRECT HOST RULE: HF's own redirect chain leaves huggingface.co for a separate host to
 *  serve LFS/Xet-tracked file bytes (e.g. `us.aws.cdn.hf.co`), and specific CDN hostnames have
 *  changed, unannounced, more than once. So this pins the two SUFFIXES Hugging Face's own
 *  community guidance says cover every current and future storage/CDN host ("huggingface.co" and
 *  "hf.co") rather than a fixed hostname list. */
const ALLOWED_DOWNLOAD_HOST_SUFFIXES = ["huggingface.co", "hf.co"];

function isAllowedDownloadHost(hostname: string): boolean {
  return ALLOWED_DOWNLOAD_HOST_SUFFIXES.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  );
}

function hostnameOf(urlString: string): string {
  try {
    return new URL(urlString).hostname;
  } catch {
    return "";
  }
}

/** `redirect: "manual"` stops `fetchFn` from auto-following, so each hop's `Location` header is
 *  checked against the allowlist BEFORE ever connecting to it (Bun returns the real 3xx status and
 *  headers, not an opaque redirect). A relative Location resolves against the CURRENT url; a small
 *  bounded hop count refuses a malicious redirect loop rather than following indefinitely. */
const MAX_REDIRECT_HOPS = 5;

async function fetchFollowingAllowedRedirects(
  fetchFn: typeof fetch,
  url: string,
): Promise<Response> {
  let currentUrl = url;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    const res = await fetchFn(currentUrl, { redirect: "manual" });
    const isRedirect = res.status >= 300 && res.status < 400;
    if (!isRedirect) {
      const finalHost = hostnameOf(currentUrl);
      if (!isAllowedDownloadHost(finalHost)) {
        throw new Error(
          `refused: response from an unexpected host "${finalHost}" (not huggingface.co/hf.co or a subdomain) fetching ${url}`,
        );
      }
      return res;
    }
    const location = res.headers.get("location");
    if (!location) {
      throw new Error(`GET ${currentUrl} -> ${res.status} redirect with no Location header`);
    }
    const nextUrl = new URL(location, currentUrl).toString();
    const nextHost = hostnameOf(nextUrl);
    if (!isAllowedDownloadHost(nextHost)) {
      throw new Error(
        `refused: redirected to an unexpected host "${nextHost}" (not huggingface.co/hf.co or a subdomain) fetching ${url}`,
      );
    }
    currentUrl = nextUrl;
  }
  throw new Error(`refused: too many redirects (> ${MAX_REDIRECT_HOPS}) fetching ${url}`);
}

async function downloadFile(fetchFn: typeof fetch, url: string, destPath: string): Promise<void> {
  await mkdir(dirname(destPath), { recursive: true });
  const res = await fetchFollowingAllowedRedirects(fetchFn, url);
  if (!res.ok || !res.body) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(destPath);
    (async () => {
      try {
        for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
          // Honor write() backpressure — a fast connection writing a large file to a slow disk
          // otherwise buffers the whole response in memory instead of pausing the read side.
          const canContinue = out.write(chunk);
          if (!canContinue) {
            await new Promise<void>((drained) => out.once("drain", drained));
          }
        }
        out.end();
      } catch (e) {
        reject(e);
      }
    })();
    out.on("finish", resolve);
    out.on("error", reject);
  });
}

/** The provider's first-use fetch — called from index.ts's `loadSession` on the first `embed()`
 *  call only. Already-verified files are left untouched (fast, zero-network, no-lock path). A
 *  failed fetch/verify is retried once; a second failure names `bun run fetch-model` as the
 *  offline alternative. A cold cache is populated under the cross-process exclusive lock — two
 *  processes racing on the same cache no longer both download. */
export async function fetchAndVerifyModel(root: string, spec: ModelFetchSpec): Promise<string> {
  const resolved = resolveSpec(spec);
  const finalDir = modelDirFor(root, spec);
  if (await isVerified(finalDir, spec)) return finalDir;

  const outcome = await acquireLockOrObserveVerified(finalDir, spec, resolved);
  if (outcome === "already-verified") return finalDir;
  // Refresh starts only once THIS process holds the lock ("acquired") — a waiter observing another
  // holder's lock has nothing of its own to refresh.
  const stopLockRefresh = startLockRefresh(finalDir);
  try {
    if (await isVerified(finalDir, spec)) return finalDir;

    const unsupported = unsupportedPlatformReason(spec.platformOverride);
    if (unsupported) {
      throw new Error(`embedder-local: refusing to download — ${unsupported}`);
    }
    try {
      await downloadAndVerifyInto(finalDir, resolved);
    } catch (e) {
      throw new Error(
        `embedder-local: could not fetch/verify the pinned model weights (${resolved.modelId}@${resolved.revision}) ` +
          `into "${finalDir}": ${e instanceof Error ? e.message : String(e)}. Offline alternative: on a ` +
          `machine with network access, run "bun run fetch-model" in packages/embedder-local (or ` +
          `"bun run fetch-model --dir <path>" for a non-default root matching embeddings.localModelPath), ` +
          "then ship or mount that directory here.",
      );
    }
    return finalDir;
  } finally {
    stopLockRefresh();
    await releaseLock(finalDir);
  }
}

/** Re-verifies `modelDir` immediately before it is handed to `@huggingface/transformers`, throwing
 *  if it no longer verifies clean — closes the TOCTOU window between `fetchAndVerifyModel`'s own
 *  check and the `from_pretrained` call. Cheap: a handful of small files plus one ~20-35 MB sha256. */
export async function assertVerified(modelDir: string, spec: ModelFetchSpec): Promise<void> {
  const results = await verifyModelDir(modelDir, spec);
  const bad = results.filter((r) => !r.ok);
  if (bad.length > 0) {
    throw new Error(
      `embedder-local: model directory failed verification immediately before load: ` +
        `${bad.map((r) => `${r.file.path} (${r.reason})`).join(", ")}. Directory: ${modelDir}`,
    );
  }
}
