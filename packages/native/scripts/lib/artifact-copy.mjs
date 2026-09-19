// Pure copy-decision logic for scripts/build.mjs (THE-1080, #948).
//
// napi build's own post-build step copies the freshly linked `.node` into the crate folder; on
// Windows, when a running process (an MCP client such as Claude Code, with dist/cli.js having
// `require()`d the addon) still holds that file open, the copy fails with a bare
// "Internal Error: Failed to copy artifact" -- no errno, no path -- even when the newly built
// bytes are identical to what's already on disk. build.mjs routes around napi's copy step by
// building into a staging directory and calling copyArtifactIfChanged() itself; this module is
// the isolated decision (skip when identical, else copy+rename) so it is testable without
// `napi build`, cargo, or a compiler.

import { createHash } from "node:crypto";

export class ArtifactCopyError extends Error {
  constructor(message, { code, destPath }) {
    super(message);
    this.name = "ArtifactCopyError";
    this.code = code;
    this.destPath = destPath;
  }
}

// Lock-style errors a stale reader/loader can produce on the destination file. EBUSY/ETXTBSY are
// the direct "still open" signals; EPERM/EACCES are what Windows reports for the same condition on
// some filesystems/AV configurations.
const LOCK_CODES = new Set(["EBUSY", "EPERM", "ETXTBSY", "EACCES"]);

function sha256(fsImpl, path) {
  return createHash("sha256").update(fsImpl.readFileSync(path)).digest("hex");
}

/** Hashes the destination, or null if it can't be read (e.g. exclusively locked on Windows) -- a
 * read failure there is treated as "differs", not as an error, so the copy/rename path below runs
 * and surfaces the real, typed lock error instead of a raw readFileSync throw with no destination
 * path or errno context attached. */
function readDestHashOrNull(fsImpl, path) {
  try {
    return sha256(fsImpl, path);
  } catch {
    return null;
  }
}

function lockHint(platform) {
  return platform === "win32"
    ? "a running process has the addon loaded (an MCP client such as Claude Code running " +
        "dist/cli.js); stop it and re-run"
    : "another process may hold the file open";
}

/**
 * Copies `srcPath` over `destPath`, skipping the write when the two files already have identical
 * contents. `fsImpl` supplies {existsSync, readFileSync, copyFileSync, renameSync, unlinkSync} --
 * injectable so tests can simulate a locked destination without a real lock. `platform` is
 * `process.platform`, injected so the platform-specific hint can be exercised from any host.
 *
 * Returns `{ action: "skipped" | "copied", destPath }`. Throws ArtifactCopyError (with `.code` and
 * `.destPath`) when the copy/rename fails with one of LOCK_CODES; any other error propagates as-is.
 */
export function copyArtifactIfChanged({ srcPath, destPath, platform, fsImpl }) {
  if (fsImpl.existsSync(destPath)) {
    const destHash = readDestHashOrNull(fsImpl, destPath);
    if (destHash !== null && destHash === sha256(fsImpl, srcPath)) {
      return { action: "skipped", destPath };
    }
  }

  // Ends in ".node" (matching the repo's `*.node` gitignore pattern) so a temp file left behind by
  // a crash between copyFileSync and renameSync -- or by the exit-handler cleanup below losing the
  // race -- can never end up tracked by git.
  const tmpPath = `${destPath}.tmp-${process.pid}-${Date.now()}.node`;
  const cleanupTmp = () => {
    try {
      fsImpl.unlinkSync(tmpPath);
    } catch {
      // best-effort: either already gone (renamed away, or never created) or truly stuck, in
      // which case there is nothing more this process can do about it.
    }
  };
  // Best-effort net for a hard crash between copyFileSync and renameSync; removed again below once
  // this call has resolved one way or the other, so it never leaks across repeated invocations of
  // this function within one process (e.g. one per staged artifact in build.mjs's loop).
  process.on("exit", cleanupTmp);
  try {
    fsImpl.copyFileSync(srcPath, tmpPath);
    fsImpl.renameSync(tmpPath, destPath);
  } catch (err) {
    cleanupTmp();
    if (LOCK_CODES.has(err.code)) {
      throw new ArtifactCopyError(
        `native build: failed to update ${destPath} (errno ${err.code}); ${lockHint(platform)}`,
        { code: err.code, destPath },
      );
    }
    throw err;
  } finally {
    process.removeListener("exit", cleanupTmp);
  }
  return { action: "copied", destPath };
}
