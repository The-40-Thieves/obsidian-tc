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
import { createWriteStream, type Dirent } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MODEL_ID, MODEL_REVISION, PINNED_FILES, type PinnedFile } from "./model-info.js";

/** THE-944 review round 1 ("Also"/F11): refuse a DOWNLOAD (never a read of already-verified,
 *  pre-staged files — see fetchAndVerifyModel below) on a platform with no onnxruntime-node native
 *  prebuild, so an auto-selected deployment on darwin-x64/musl never spends the ~23 MB download only
 *  to fail later at model-load time inside @huggingface/transformers. Deliberately DUPLICATED, not
 *  imported, from packages/server/src/doctor/checks.ts's `onnxNativePrebuildStatus`: this package is
 *  standalone on purpose (see README.md's "why this package is NOT a root workspace member") and
 *  must not depend on packages/server. Keep both in sync if onnxruntime-node's supported-platform
 *  matrix changes — confirmed today: linux x64/arm64 glibc, darwin arm64, win32 x64/arm64 only; musl
 *  and darwin x64 have none. Same musl-detection technique (process.report's own
 *  `header.glibcVersionRuntime`, present on glibc, absent on musl) — dependency-free, not airtight
 *  against an unusual custom Node build. */
export function unsupportedPlatformReason(
  opts: { platform?: NodeJS.Platform; arch?: string; isMuslRuntime?: () => boolean } = {},
): string | undefined {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  if (platform === "darwin" && arch === "x64") {
    return (
      "this platform (darwin-x64 / Intel Mac) has NO onnxruntime-node prebuilt binary — the " +
      '"local" reranker cannot run here regardless of whether the pinned weights are fetched.'
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
      'the "local" reranker cannot run here regardless of whether the pinned weights are fetched.'
    );
  }
  return undefined;
}

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
  /** Forwarded verbatim to `unsupportedPlatformReason` — real callers never set this (it reads the
   *  REAL process); tests use it to exercise the darwin-x64/musl branches without faking ambient
   *  `process.platform`. */
  platformOverride?: Parameters<typeof unsupportedPlatformReason>[0];
  /** THE-944 review round 2 (G1): how old a lock (its `owner.json`'s `startedAt`) may be before a
   *  NEW fetcher takes it over instead of waiting — real callers never set this (see
   *  `acquireLockOrObserveVerified`'s own comment for the default and why). Tests shrink it to make
   *  a stale-lock takeover assertable in milliseconds instead of minutes. */
  lockStaleMs?: number;
  /** THE-944 review round 2 (G1): how long to sleep between lock-acquisition polls — real callers
   *  never set this. Tests shrink it so a two-fetcher race resolves in milliseconds. */
  lockPollMs?: number;
}

interface ResolvedSpec {
  modelId: string;
  revision: string;
  pinnedFiles: readonly PinnedFile[];
  fetchFn: typeof fetch;
  lockStaleMs: number;
  lockPollMs: number;
}

const DEFAULT_LOCK_STALE_MS = 10 * 60 * 1000; // 10 minutes: a healthy ~23 MB fetch (+ one retry)
// finishes in well under this even on a slow connection; a lock older than this almost certainly
// belongs to a process that crashed mid-download, not one still legitimately working.
const DEFAULT_LOCK_POLL_MS = 200;

function resolveSpec(spec: ModelFetchSpec = {}): ResolvedSpec {
  return {
    modelId: spec.modelId ?? MODEL_ID,
    revision: spec.revision ?? MODEL_REVISION,
    pinnedFiles: spec.pinnedFiles ?? PINNED_FILES,
    fetchFn: spec.fetchFn ?? fetch,
    lockStaleMs: spec.lockStaleMs ?? DEFAULT_LOCK_STALE_MS,
    lockPollMs: spec.lockPollMs ?? DEFAULT_LOCK_POLL_MS,
  };
}

async function sha256File(path: string): Promise<string> {
  const buf = await readFile(path);
  return createHash("sha256").update(buf).digest("hex");
}

/** THE-944 review round 2 (G2): every relative FILE path actually present under `dir` — a
 *  recursive walk using `readdir(..., { withFileTypes: true })`, whose `Dirent` classification
 *  (`isSymbolicLink()`/`isDirectory()`/`isFile()`) reflects the entry itself (lstat-like), never
 *  the target of a symlink. A symlinked entry is recorded as a leaf (never descended into, never
 *  trusted as a directory) so `verifyModelDir` below can flag it as "not one of the pinned files"
 *  even when its NAME happens to collide with a real subdirectory (e.g. a symlink named `onnx`
 *  pointing elsewhere). Missing `dir` -> empty list, not an error: a not-yet-created target
 *  directory is simply "nothing here yet", which `verifyModelDir`'s per-pinned-file loop already
 *  reports as "missing" on its own. */
async function listRelativeEntries(dir: string): Promise<string[]> {
  const out: string[] = [];
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
        out.push(rel);
      } else if (e.isDirectory()) {
        await walk(rel);
      } else {
        out.push(rel);
      }
    }
  }
  await walk("");
  return out;
}

/** Checks every pinned file's presence, size, and sha256 under `modelDir` (the REVISION-scoped
 *  directory — see `modelDirFor`). Read-only, no network. Shared by the doctor-facing
 *  `bun run fetch-model --check` path and this module's own "is a re-download needed" check.
 *
 *  THE-944 review round 2 (G2) hardening, against a plausible adversary with write access to the
 *  cache directory (a shared cache, a compromised sibling process, ...):
 *    1. `lstat`, never `stat`/`existsSync` — the pre-round-2 implementation FOLLOWED symlinks, so a
 *       pinned filename could be replaced with a symlink pointing at arbitrary bytes elsewhere on
 *       disk while this check still reported "verified" (it hashed whatever the link resolved to,
 *       which could change between verify and load — see G2's other requirement, `assertVerified`,
 *       for closing that half). A symlink is refused outright, never followed.
 *    2. Every entry actually present under `modelDir` (recursively) is compared against the exact
 *       pinned-file set — an EXTRA file (planted, not overwriting a known name) is refused too,
 *       closing the gap a per-pinned-file check alone cannot see. */
export async function verifyModelDir(
  modelDir: string,
  spec: ModelFetchSpec = {},
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
  for (const rel of present) {
    if (!expected.has(rel)) {
      results.push({
        file: { path: rel, sha256: "", sizeBytes: -1 },
        ok: false,
        reason: "refused: unexpected entry present (not one of the pinned files)",
      });
    }
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

/** True when every pinned file verifies clean AND at least one was checked (an empty pinned-files
 *  list is never "verified" — that would be vacuously true for a misconfigured spec). Shared by the
 *  cross-process lock's fast paths and `downloadAndVerifyInto`'s pre-publish re-check below. */
async function isVerified(dir: string, spec: ModelFetchSpec): Promise<boolean> {
  const results = await verifyModelDir(dir, spec);
  return results.length > 0 && results.every((r) => r.ok);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** THE-944 review round 2 (G1): the cross-process lock directory for `finalDir` — a SIBLING path,
 *  never inside `finalDir` itself, so a lock can exist (or be taken over) independently of whatever
 *  state `finalDir` is in. */
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

/** `mkdir` (non-recursive) is the exclusive-create primitive: it throws EEXIST if `lockDir`
 *  already exists and is atomic on every filesystem this repo targets, which a lockFILE opened
 *  with `wx` is not guaranteed to be on every platform/filesystem combination (notably some
 *  network filesystems) — `mkdir` is the more portable of the two options THE-944's own fix
 *  request named. Returns false (never throws) when another holder already has it. */
async function tryAcquireLock(finalDir: string): Promise<boolean> {
  const lockDir = lockDirFor(finalDir);
  // The PARENT of lockDir (== finalDir's own parent, e.g. <root>/<model-id>/) may not exist yet on
  // a cold cache — recursive mkdir of the parent is idempotent and NOT the exclusivity boundary;
  // only the final, non-recursive mkdir(lockDir) below is. Two racing processes both running this
  // recursive mkdir concurrently is safe: it never throws EEXIST for an already-existing directory
  // (unlike the non-recursive form), so it cannot itself cause a false "someone else has the lock".
  await mkdir(dirname(lockDir), { recursive: true });
  try {
    await mkdir(lockDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
  // Record who holds it, for stale-lock detection below. A narrow window exists between mkdir
  // succeeding and this write landing, during which a waiter's readLockOwner sees "no owner file
  // yet" — handled as "not stale" (never a false takeover), see acquireLockOrObserveVerified.
  await writeFile(
    join(lockDir, "owner.json"),
    JSON.stringify({ pid: process.pid, startedAt: Date.now() } satisfies LockOwner),
  );
  return true;
}

async function releaseLock(finalDir: string): Promise<void> {
  await rm(lockDirFor(finalDir), { recursive: true, force: true });
}

/** Waits (polling) until EITHER (a) this process acquires the exclusive lock for `finalDir`, or
 *  (b) `finalDir` becomes independently verified — by whoever currently holds the lock finishing
 *  its own publish — in which case NO lock is ever acquired by this call at all. That second
 *  outcome is the whole point: two processes racing to populate the SAME cold cache should not both
 *  download; the second one should notice the first one's work and use it.
 *
 *  A lock older than `lockStaleMs` (default 10 minutes — see that constant's own comment) is taken
 *  over: removed and retried immediately, rather than waited on forever. A holder that crashed
 *  mid-download (killed, OOM, ...) would otherwise wedge every future fetch on this path permanently
 *  — the SAME "a transient failure must not permanently wedge the reranker" principle
 *  index.ts's `sessions` memo already documents for the in-process case. */
async function acquireLockOrObserveVerified(
  finalDir: string,
  spec: ModelFetchSpec,
  resolved: ResolvedSpec,
): Promise<"acquired" | "already-verified"> {
  for (;;) {
    if (await isVerified(finalDir, spec)) return "already-verified";
    if (await tryAcquireLock(finalDir)) return "acquired";
    const owner = await readLockOwner(lockDirFor(finalDir));
    if (owner && Date.now() - owner.startedAt > resolved.lockStaleMs) {
      await rm(lockDirFor(finalDir), { recursive: true, force: true }).catch(() => undefined);
      continue; // retry acquisition immediately — already known stale, no need to sleep first
    }
    await sleep(resolved.lockPollMs);
  }
}

/** Downloads every pinned file into a fresh TEMP directory beside `finalDir`, verifies the WHOLE
 *  batch, and only then renames the temp directory over `finalDir` in one `rename()` call —
 *  `finalDir` therefore only ever transitions from "previous state" to "fully verified new state";
 *  no reader can ever observe a partially-downloaded set of files at the real path. One retry (a
 *  second, fresh temp dir) before giving up — deliberately whole-batch rather than per-file: this
 *  model is one ~23 MB file plus five small ones, so re-fetching everything on any single failure
 *  trades a little bandwidth for never having to reason about a half-good, half-bad directory.
 *
 *  THE-944 review round 2 (G1): called only while this process holds the cross-process lock (see
 *  `fetchAndVerifyModel` below), so under normal operation nothing else can be racing on the SAME
 *  `finalDir` while this runs. The "never rm a finalDir that verifies" re-check right before
 *  publish is defense in depth on top of that, not instead of it: if `finalDir` already verifies
 *  clean by the time this attempt is ready to publish (a bug in the locking, or a legitimate
 *  outside actor having populated it), this attempt's own temp dir is discarded as redundant rather
 *  than replacing a directory that is already good. */
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
      // Verifies the TEMP dir before it is ever treated as a publish candidate — the SAME
      // lstat/symlink/extraneous-entry hardened check `verifyModelDir` runs on `finalDir` at
      // publish time and again in `assertVerified` right before load (G2).
      const results = await verifyModelDir(tmpDir, { pinnedFiles });
      const bad = results.filter((r) => !r.ok);
      if (bad.length > 0) {
        throw new Error(
          `${bad.length}/${results.length} pinned files failed verification after download: ` +
            bad.map((r) => `${r.file.path} (${r.reason})`).join(", "),
        );
      }
      // G1: never rm a finalDir that ALREADY verifies — see this function's own header comment.
      if (await isVerified(finalDir, { pinnedFiles })) {
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

/** THE-944 review round 2 (G4): downloadFile follows redirects (fetch's default `redirect:
 *  "follow"`) — HF's own redirect chain leaves huggingface.co for a separate host to serve the
 *  actual bytes of LFS/Xet-tracked files. Observed LIVE today (2026-09-03) via `curl -sI -L`
 *  against this package's own pinned URL: the ~23 MB onnx file 302s from
 *  `huggingface.co/.../resolve/...` to `https://us.aws.cdn.hf.co/xet-bridge-us/...`; the small
 *  non-LFS files (config.json, tokenizer.json, vocab.txt, ...) 307 to a SAME-host
 *  `/api/resolve-cache/...` path instead. Specific CDN hostnames have changed, unannounced, more
 *  than once (`cdn-lfs.huggingface.co` -> `cdn-lfs.hf.co`, then Xet's `*.xethub.hf.co` /
 *  `*.aws.cdn.hf.co` bridge hosts) — see
 *  https://discuss.huggingface.co/t/hf-hub-cdn-urls-changes-notifications/114653 and
 *  https://discuss.huggingface.co/t/how-to-get-a-list-of-all-huggingface-download-redirections-to-whitelist/30486 —
 *  so this pins the two SUFFIXES Hugging Face's own community guidance says cover every current
 *  and future storage/CDN host ("huggingface.co" and "hf.co"), not a fixed hostname list that
 *  would need updating every time HF reshuffles its CDN. Refusing anything else after redirects
 *  are followed is what actually closes the exposure: without this, a compromised/MITM'd
 *  huggingface.co response (or a malicious mirror someone points `modelId` at via an injected
 *  spec) could redirect this download to an arbitrary host and this code would fetch — and, before
 *  G2's hardening, even trust — whatever came back. */
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

async function downloadFile(fetchFn: typeof fetch, url: string, destPath: string): Promise<void> {
  await mkdir(dirname(destPath), { recursive: true });
  const res = await fetchFn(url);
  if (!res.ok || !res.body) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }
  // `res.url` is the FINAL url after every redirect the fetch implementation followed — empty for
  // a bare `new Response(...)` never actually fetched (this package's own tests construct
  // responses that way), in which case there is no redirect information at all and the originally
  // REQUESTED url (always huggingface.co in production) is the only fact available.
  const finalUrl = res.url && res.url.length > 0 ? res.url : url;
  const finalHost = hostnameOf(finalUrl);
  if (!isAllowedDownloadHost(finalHost)) {
    throw new Error(
      `refused: redirected to an unexpected host "${finalHost}" (not huggingface.co/hf.co or a subdomain) fetching ${url}`,
    );
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

/** THE-944: the provider's first-use fetch — called from index.ts's `loadSession`, on the first
 *  `rerank()` call only (never at import time). `root` is whatever `localModelPath` resolved to
 *  (this package's own `models/` directory by default, or an operator's `reranker.localModelPath`
 *  override). Already-verified files are left untouched — this is the fast, common-case,
 *  zero-network, NO-LOCK path once the weights are cached. A failed fetch/verify is retried once; a
 *  second failure throws an error naming `bun run fetch-model` (this package's manual script) as
 *  the offline alternative — pre-populate the SAME directory from a machine with network access.
 *
 *  THE-944 review round 2 (G1): a cold cache is populated under a cross-process exclusive lock
 *  (`acquireLockOrObserveVerified`) — two processes (or two Node workers, two containers sharing a
 *  bind-mounted cacheDir, ...) that both miss the cache at the same moment no longer BOTH download:
 *  one wins the lock and publishes; the other either waits and then finds the freshly-verified
 *  directory (never acquiring the lock at all), or takes over a stale lock if the winner crashed
 *  mid-download. */
export async function fetchAndVerifyModel(
  root: string,
  spec: ModelFetchSpec = {},
): Promise<string> {
  const resolved = resolveSpec(spec);
  const finalDir = modelDirFor(root, spec);
  if (await isVerified(finalDir, spec)) return finalDir;

  const outcome = await acquireLockOrObserveVerified(finalDir, spec, resolved);
  if (outcome === "already-verified") return finalDir;
  try {
    // Double-checked: another process may have finished publishing in the narrow window between
    // this function's OWN first check above and actually acquiring the lock.
    if (await isVerified(finalDir, spec)) return finalDir;

    // THE-944 review round 1: the platform check runs BEFORE the download attempt, not after — a
    // pre-staged, already-verified cache (checked above) still works on any platform (someone may
    // have copied files over for testing), but a fresh download never starts on a platform that
    // cannot run the model regardless.
    const unsupported = unsupportedPlatformReason(spec.platformOverride);
    if (unsupported) {
      throw new Error(`reranker-local: refusing to download — ${unsupported}`);
    }
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
  } finally {
    await releaseLock(finalDir);
  }
}

/** THE-944 review round 2 (G2): re-verify `modelDir` immediately before it is handed to
 *  `@huggingface/transformers`, and throw (never return) if it no longer verifies clean. Exported
 *  and called EXPLICITLY by index.ts's `loadSession`, as a step distinct from whatever
 *  `fetchAndVerifyModel` itself already checked — closing the TOCTOU window between that
 *  verification and the `from_pretrained` calls: a byte swapped on disk in that gap (or a symlink
 *  planted after the fact) is caught here, not silently loaded. Cheap — a handful of small files
 *  plus one ~23 MB sha256, no network. */
export async function assertVerified(modelDir: string, spec: ModelFetchSpec = {}): Promise<void> {
  const results = await verifyModelDir(modelDir, spec);
  const bad = results.filter((r) => !r.ok);
  if (bad.length > 0) {
    throw new Error(
      `reranker-local: model directory failed verification immediately before load: ` +
        `${bad.map((r) => `${r.file.path} (${r.reason})`).join(", ")}. Directory: ${modelDir}`,
    );
  }
}
