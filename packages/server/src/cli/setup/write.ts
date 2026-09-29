// `obsidian-tc setup`'s config writer. Two jobs, kept together deliberately: build the exact raw
// object the decision translates to (buildSetupConfig, pure), and get it onto disk safely
// (writeSetupConfig, the only I/O in this module). See test/setup-write*.test.ts.
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { type ServerConfig, ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { CliError } from "../cli-error";
import type { SetupDecision } from "./decide";

/** Files this command creates (config, backups, temp files) are never world/group-readable by
 *  default — Node's temp-file default of `0666 & umask` (commonly 0644) would otherwise let
 *  `--force` replace a protected 0600 config with a world-readable one. */
const MODE_OWNER_RW = 0o600;

/**
 * The raw config object `obsidian-tc setup` writes — every key the decision made EXPLICIT (detect
 * once, write the decision down, never re-detect silently at boot). Deliberately does NOT set
 * `embeddings.threads`: leaving it unset keeps the default cap (a quarter of the host's cores,
 * spinning disabled — see `EmbeddingsConfigLike.threads`'s own doc comment) in force, which is
 * right for every machine this detects on, not a value `setup` would have to re-derive.
 *
 * When `existingRaw` is given (an existing config already loaded off disk — see
 * cli/commands/setup.ts's `detect`), this MERGES rather than replaces: every top-level key setup
 * does not own is carried through unchanged, `vaults` is a union (existing entries win on an id
 * collision, newly detected ones are appended), `cacheDir` is only filled when the existing raw
 * file never named it explicitly, and `embeddings` is only filled when it never named `provider`
 * explicitly — an operator's own prior choice is never silently overwritten.
 */
export function buildSetupConfig(
  decision: SetupDecision,
  existingRaw?: Record<string, unknown>,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const base: Record<string, unknown> = existingRaw ? { ...existingRaw } : {};
  // Finding 1: `setupOrigin` is owned by `extra` below, not echoed through like other unowned keys.
  delete base.setupOrigin;

  const existingVaults = Array.isArray(base.vaults)
    ? (base.vaults as Array<{ id?: unknown; path?: unknown }>).filter(
        (v): v is { id: string; path: string } =>
          typeof v?.id === "string" && typeof v?.path === "string",
      )
    : [];
  const existingVaultIds = new Set(existingVaults.map((v) => v.id));
  base.vaults = [
    ...existingVaults,
    ...decision.vaults
      .filter((v) => !existingVaultIds.has(v.id))
      .map((v) => ({ id: v.id, path: v.path })),
  ];

  if (!("cacheDir" in base)) {
    base.cacheDir = decision.cacheDir;
  }

  const existingEmbeddings =
    typeof base.embeddings === "object" &&
    base.embeddings !== null &&
    !Array.isArray(base.embeddings)
      ? (base.embeddings as Record<string, unknown>)
      : undefined;
  // A pre-1.31.4 config could set `model`/`dimensions` WITHOUT ever setting `provider`
  // (sticky-provider.ts's own header names this exact historical shape) — a gate on `provider`
  // alone would read that as "not explicit" and overwrite the operator's own choice. Any of the
  // three fields present already means SOME explicit embeddings choice was made here.
  const embeddingsProviderExplicit =
    existingEmbeddings !== undefined &&
    ("provider" in existingEmbeddings ||
      "model" in existingEmbeddings ||
      "dimensions" in existingEmbeddings);
  if (decision.embeddings !== undefined && !embeddingsProviderExplicit) {
    base.embeddings = {
      ...existingEmbeddings,
      provider: decision.embeddings.provider,
      model: decision.embeddings.model,
      dimensions: decision.embeddings.dimensions,
      ...(decision.embeddings.revision !== undefined
        ? { revision: decision.embeddings.revision }
        : {}),
    };
  } else if (existingEmbeddings !== undefined) {
    base.embeddings = existingEmbeddings;
  }

  return extra ? { ...base, ...extra } : base;
}

export interface SetupWriteResult {
  path: string;
  /** Set only when an existing file was overwritten with --force. */
  backupPath?: string;
  config: ServerConfig;
  raw: Record<string, unknown>;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** True for a symlink (never a broken-link vs directory distinction — lstatSync throws on neither
 *  a missing path nor a permission problem, both of which the caller treats identically: "not a
 *  symlink we need to chase"). */
function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** A `--config` path that is itself a symlink must have its REFERENT backed up and rewritten,
 *  never have the link pathname replaced with a regular file (which silently detaches it from
 *  whatever it used to point at). A broken link is refused outright — writing a NEW file at the
 *  link's own name would not obviously be the operator's intent. */
function resolveWriteTarget(path: string): string {
  if (!isSymlink(path)) return path;
  try {
    return realpathSync(path);
  } catch {
    throw new CliError(
      `${path} is a symlink to a target that does not exist — refusing to replace the link itself. Point --config at the real file, or remove the broken link first.`,
    );
  }
}

/** The existing file's own mode, or undefined if it cannot be stat'd (never treated as a reason to
 *  fail the whole write — just means "nothing stricter to preserve"). */
function existingFileMode(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return undefined;
  }
}

/** "Stricter than 0o600" means "grants no MORE than the owner read/write this writer already
 *  uses, and NOTHING to group/other" — a raw numeric `<` comparison against 0o600 would read
 *  0o444/0o477 as stricter purely for being numerically smaller, when both are WORLD-READABLE.
 *  0o400 (owner read-only) IS actually stricter, and is the case preserved. */
function isStricterThanOwnerRW(mode: number): boolean {
  return (mode & 0o077) === 0 && (mode & ~MODE_OWNER_RW) === 0;
}

/** An exclusive (`wx`) create per candidate name, with a numeric suffix appended on `EEXIST`, so
 *  two overlapping `--force` re-runs (or two within the same ISO-millisecond timestamp) can never
 *  clobber an earlier backup. Fsyncs the backup's own fd before closing — a crash right after
 *  backing up must not lose the backup itself. */
function backupExistingFile(path: string): string {
  const data = readFileSync(path);
  const base = `${path}.bak-${timestamp()}`;
  for (let n = 0; ; n++) {
    const candidate = n === 0 ? base : `${base}-${n}`;
    let fd: number;
    try {
      fd = openSync(candidate, "wx", MODE_OWNER_RW);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw e;
    }
    try {
      writeSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return candidate;
  }
}

// Writes `content` (text) to a brand-new, exclusively-created temp file at `mode`, fsyncing before
// returning; removes the partial file on failure. Text, so a JSONC writer can pass edited text through as-is.
function writeTempFile(dir: string, content: string, mode: number): string {
  const tmpPath = join(
    dir,
    `.tmp-obsidian-tc-setup-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const fd = openSync(tmpPath, "wx", mode);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    try {
      unlinkSync(tmpPath);
    } catch {
      /* best-effort cleanup */
    }
    throw e;
  }
  closeSync(fd);
  return tmpPath;
}

/** Best-effort directory fsync (durability for the rename/link itself) — not every platform
 *  supports opening a directory for fsync (notably Windows), so a failure here is swallowed rather
 *  than failing an otherwise-successful write. */
function fsyncDirBestEffort(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* best-effort: not fatal, and not every platform supports this */
  }
}

/** Copies `tmpPath`'s bytes over `target` IN PLACE (truncate + write + fsync) — the last-resort
 *  fallback both finalization paths below share when their preferred primitive (rename/link) isn't
 *  available. Not atomic across a crash mid-copy the way rename/link is, but by the time either
 *  caller reaches this, a pre-write backup (`--force`) or an exclusive `wx` create (no `--force`)
 *  has already supplied that code path's durability guarantee. */
function copyOverInPlace(tmpPath: string, target: string, mode: number): void {
  const data = readFileSync(tmpPath);
  const fd = openSync(target, "w", mode);
  try {
    // `openSync`'s `mode` arg only applies when the call CREATES the file — `target` already
    // exists here, so its OLD, possibly looser permissions would otherwise sit on the NEW content
    // (which may carry real secrets) until the end-of-function chmodSync runs. Tighten the open
    // fd's mode BEFORE writing, closing that window at the source. Skipped on win32: no POSIX
    // group/other bits there, and fchmodSync only toggles read-only (risking the EPERM this
    // fallback exists to route around).
    if (process.platform !== "win32") {
      try {
        fchmodSync(fd, mode);
      } catch {
        /* best-effort — the end-of-function chmodSync is the fallback for the end state */
      }
    }
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** `--force`'s finalization step. A `renameSync` over an EXISTING target can fail with EPERM/EACCES
 *  on Windows when that target carries the read-only attribute (this writer's own restrictive mode,
 *  or an operator's own chmod — reproduced in CI, windows-latest, the "STRICTER existing mode"
 *  test). EBUSY covers the sharing-violation case (an AV scanner or search indexer briefly has the
 *  file open). Clears the read-only bit and retries once; if that still fails, falls back to
 *  copying the new content over the target in place (finding 3: `finalizeForceWriteNamingBackup`
 *  below names the pre-write backup if THIS fails too). Any OTHER error is rethrown unchanged —
 *  see setup-write-crash.test.ts's "a failing renameSync" case. */
function finalizeForceWrite(tmpPath: string, target: string, mode: number): void {
  try {
    renameSync(tmpPath, target);
    return;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") throw e;
  }
  try {
    chmodSync(target, MODE_OWNER_RW);
    renameSync(tmpPath, target);
    return;
  } catch {
    /* the retry failed too (a real sharing violation, not a stale read-only bit) — copy-over below
     * is the last resort, not re-thrown from here so its own errors are the ones that surface. */
  }
  copyOverInPlace(tmpPath, target, mode);
  unlinkSync(tmpPath);
}

// Finding 3: names the pre-write backup on a failure here (recovery path for the non-atomic copy).
function finalizeForceWriteNamingBackup(
  tmpPath: string,
  target: string,
  mode: number,
  backupPath: string | undefined,
): void {
  try {
    finalizeForceWrite(tmpPath, target, mode);
  } catch (e) {
    if (backupPath === undefined) throw e;
    const message = e instanceof Error ? e.message : String(e);
    throw new CliError(
      `writing ${target} failed (${message}) after a backup of the previous config was already made at ${backupPath} — restore that backup if ${target} is now missing or incomplete.`,
    );
  }
}

// Finding 2: the marker is a TTL lock (holder pid + claim time), so a crashed holder self-heals.
const MARKER_TTL_MS = 30_000;

interface MarkerClaim {
  pid: number;
  ts: number;
}

// Undefined (unreadable/corrupt/vanished) reads as reclaimable, not still-live.
function readMarkerClaim(marker: string): MarkerClaim | undefined {
  try {
    const parsed = JSON.parse(readFileSync(marker, "utf8")) as Partial<MarkerClaim>;
    if (typeof parsed.pid === "number" && typeof parsed.ts === "number") {
      return { pid: parsed.pid, ts: parsed.ts };
    }
  } catch {}
  return undefined;
}

// `kill(pid, 0)` sends no signal; ESRCH means gone, any other error means alive-but-not-ours.
function isPidAliveOnThisHost(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function isMarkerStale(marker: string): boolean {
  const claim = readMarkerClaim(marker);
  if (claim === undefined) return true;
  if (!isPidAliveOnThisHost(claim.pid)) return true;
  return Date.now() - claim.ts > MARKER_TTL_MS;
}

// No-`--force` finalization; `retriedStaleMarker` bounds the stale-marker self-heal to one retry.
function finalizeExclusiveCreate(
  tmpPath: string,
  target: string,
  mode: number,
  retriedStaleMarker = false,
): void {
  try {
    linkSync(tmpPath, target);
    return;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw exclusiveCreateRefused(target);
    if (code !== "EPERM" && code !== "EXDEV" && code !== "ENOTSUP" && code !== "ENOSYS") throw e;
  }
  const marker = `${target}.wx-claim`;
  let markerFd: number;
  try {
    markerFd = openSync(marker, "wx", mode);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      // Finding 1: name the marker so the caller's race-read retry can wait, not fail outright.
      if (existsSync(target)) throw exclusiveCreateRefused(target);
      if (!retriedStaleMarker && isMarkerStale(marker)) {
        try {
          unlinkSync(marker);
        } catch {}
        finalizeExclusiveCreate(tmpPath, target, mode, true);
        return;
      }
      throw markerHeldRefused(marker, target);
    }
    throw e;
  }
  try {
    writeSync(markerFd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
  } catch (e) {
    closeSync(markerFd);
    try {
      unlinkSync(marker);
    } catch {}
    throw e;
  }
  closeSync(markerFd);
  try {
    if (existsSync(target)) throw exclusiveCreateRefused(target);
    // Finding 5: pid+timestamp+random, matching `writeTempFile` — pid alone can raw-EEXIST a retry.
    const staged = `${target}.wx-stage-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const data = readFileSync(tmpPath);
    const stagedFd = openSync(staged, "wx", mode);
    try {
      writeSync(stagedFd, data);
      fsyncSync(stagedFd);
    } catch (e) {
      closeSync(stagedFd);
      try {
        unlinkSync(staged);
      } catch {}
      throw e;
    }
    closeSync(stagedFd);
    let renamed = false;
    try {
      renameSync(staged, target);
      renamed = true;
    } finally {
      if (!renamed) {
        try {
          unlinkSync(staged);
        } catch {}
      }
    }
  } finally {
    try {
      unlinkSync(marker);
    } catch {
      /* best-effort */
    }
  }
}

function exclusiveCreateRefused(target: string): CliError {
  return new CliError(
    `a config already exists at ${target} — pass --force to overwrite (a timestamped backup is made first), or --config <other-path> to write somewhere else.`,
  );
}

// Finding 2: names the marker (target doesn't exist yet).
function markerHeldRefused(marker: string, target: string): CliError {
  return new CliError(
    `a config write for ${target} is already in progress by another obsidian-tc process (marker held at ${marker}) — wait a moment and retry, or remove ${marker} yourself if you are certain no obsidian-tc process is currently writing there.`,
  );
}

/**
 * Validate the decision through `ServerConfigSchema` (never write a config the server itself would
 * refuse to load) and write it atomically: a temp file in the SAME directory, then finalized into
 * place — an interrupted write can never leave a half-written config at the real path.
 *
 * The no-`--force` path is end-to-end exclusive. The temp file is created with `wx` (fails if that
 * exact name exists, astronomically unlikely given the pid+timestamp+random suffix), then
 * `linkSync`'d onto the target — `linkSync` fails with `EEXIST` if the target now exists, even if
 * it appeared AFTER this function's own `existsSync` check (two concurrent no-`--force` writers
 * racing each other). `--force` keeps the original backup-then-`renameSync` shape, since an
 * operator who passed `--force` has already opted into replacing whatever is there.
 *
 * Refuses to overwrite an existing file unless `force` is set; with `force`, the existing file is
 * copied to a timestamped, exclusively-created `<path>.bak-<ISO8601>[-N]` FIRST, so a bad re-run
 * never loses the prior config with no way back. Every file this creates lands at `0o600`;
 * `--force` preserves the existing file's own mode instead when it is STRICTER (an operator who
 * already locked a config down further must not have that loosened back to the default).
 *
 * The loader (`config/load.ts`) reads JSON only — no YAML support exists despite the docs page
 * being named `config-yaml.md` (that is a page slug, not a format) — so a `.yaml`/`.yml` target is
 * refused up front rather than silently writing JSON into a file the server can never load back.
 */
export function writeSetupConfig(
  path: string,
  decision: SetupDecision,
  opts: {
    force?: boolean;
    existingRaw?: Record<string, unknown>;
    provenance?: Record<string, unknown>;
  } = {},
): SetupWriteResult {
  if (/\.ya?ml$/i.test(path)) {
    throw new CliError(
      `obsidian-tc's config loader reads JSON only (no YAML support) — refusing to write to "${path}". Pass --config with a .json path instead.`,
    );
  }
  // decideSetup refused to guess an embeddings provider (decision.refusal set, decision.embeddings
  // absent) — the command layer must have already printed that and returned, but refuse
  // defensively here too so no caller can accidentally write a config with no embeddings decision.
  if (decision.embeddings === undefined) {
    throw new CliError(
      "obsidian-tc setup: refusing to write — no embeddings decision was made (see the printed refusal). Set embeddings explicitly and re-run, or edit the config by hand.",
    );
  }
  const raw = buildSetupConfig(decision, opts.existingRaw, opts.provenance);
  // Validate BEFORE touching disk at all — a schema rejection must never leave a backup made or a
  // temp file behind.
  const config = ServerConfigSchema.parse(raw);

  const target = resolveWriteTarget(path);
  const dir = dirname(target);
  const targetExisted = existsSync(target);
  if (targetExisted && !opts.force) {
    throw new CliError(
      `a config already exists at ${target} — pass --force to overwrite (a timestamped backup is made first), or --config <other-path> to write somewhere else.`,
    );
  }
  mkdirSync(dir, { recursive: true });

  let backupPath: string | undefined;
  let preservedMode: number | undefined;
  if (targetExisted) {
    preservedMode = existingFileMode(target);
    backupPath = backupExistingFile(target);
  }
  const mode =
    preservedMode !== undefined && isStricterThanOwnerRW(preservedMode)
      ? preservedMode
      : MODE_OWNER_RW;

  let tmpPath: string | undefined;
  try {
    tmpPath = writeTempFile(dir, `${JSON.stringify(raw, null, 2)}\n`, mode);
    if (opts.force) {
      finalizeForceWriteNamingBackup(tmpPath, target, mode, backupPath);
      tmpPath = undefined; // renamed/copied away — nothing left for the finally block to clean up
    } else {
      finalizeExclusiveCreate(tmpPath, target, mode);
      // Succeeded: `target` now holds the new content (via link or fallback copy). The temp
      // file's OWN name is still ours to remove.
      unlinkSync(tmpPath);
      tmpPath = undefined;
    }
    fsyncDirBestEffort(dir);
  } finally {
    if (tmpPath !== undefined) {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* best-effort cleanup on a failed write */
      }
    }
  }
  // chmod after the rename/link, not before: the mode must apply to the file at its FINAL path
  // (some platforms/filesystems do not preserve a temp file's mode across rename/link identically
  // on every combination) — this is the one durable source of truth for "what mode did the target
  // end up at".
  chmodSync(target, mode);

  return { path: target, config, raw, ...(backupPath !== undefined ? { backupPath } : {}) };
}

export interface AtomicJsonWriteResult {
  path: string;
  backupPath?: string;
}

function writeTextFileAtomic(path: string, content: string): AtomicJsonWriteResult {
  const target = resolveWriteTarget(path);
  const dir = dirname(target);
  const targetExisted = existsSync(target);
  mkdirSync(dir, { recursive: true });

  let backupPath: string | undefined;
  let preservedMode: number | undefined;
  if (targetExisted) {
    preservedMode = existingFileMode(target);
    backupPath = backupExistingFile(target);
  }
  const mode =
    preservedMode !== undefined && isStricterThanOwnerRW(preservedMode)
      ? preservedMode
      : MODE_OWNER_RW;

  let tmpPath: string | undefined;
  try {
    tmpPath = writeTempFile(dir, content, mode);
    finalizeForceWriteNamingBackup(tmpPath, target, mode, backupPath);
    tmpPath = undefined;
    fsyncDirBestEffort(dir);
  } finally {
    if (tmpPath !== undefined) {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* best-effort cleanup on a failed write */
      }
    }
  }
  chmodSync(target, mode);

  return { path: target, ...(backupPath !== undefined ? { backupPath } : {}) };
}

// PR B: reuses the backup/atomic-write primitives above for a non-ServerConfig JSON target.
export function mergeJsonFileAtomic(
  path: string,
  raw: Record<string, unknown>,
): AtomicJsonWriteResult {
  return writeTextFileAtomic(path, `${JSON.stringify(raw, null, 2)}\n`);
}

// JSONC twin of mergeJsonFileAtomic — `text` is jsonc-parser's own edited output, written as-is.
export function mergeJsoncFileAtomic(path: string, text: string): AtomicJsonWriteResult {
  return writeTextFileAtomic(path, text.endsWith("\n") ? text : `${text}\n`);
}

export function mergeYamlFileAtomic(path: string, text: string): AtomicJsonWriteResult {
  return writeTextFileAtomic(path, text.endsWith("\n") ? text : `${text}\n`);
}
