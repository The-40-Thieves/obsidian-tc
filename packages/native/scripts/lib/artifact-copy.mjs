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

/**
 * Copies `srcPath` over `destPath`, skipping the write when the two files already have identical
 * contents. `fsImpl` supplies {existsSync, readFileSync, copyFileSync, renameSync, unlinkSync} --
 * injectable so tests can simulate a locked destination without a real lock. `platform` is
 * `process.platform`, injected so the Windows-specific hint can be exercised from any host.
 *
 * Returns `{ action: "skipped" | "copied", destPath }`. Throws ArtifactCopyError (with `.code` and
 * `.destPath`) when the copy/rename fails with one of LOCK_CODES; any other error propagates as-is.
 */
export function copyArtifactIfChanged({ srcPath, destPath, platform, fsImpl }) {
  if (fsImpl.existsSync(destPath) && sha256(fsImpl, srcPath) === sha256(fsImpl, destPath)) {
    return { action: "skipped", destPath };
  }

  const tmpPath = `${destPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fsImpl.copyFileSync(srcPath, tmpPath);
    fsImpl.renameSync(tmpPath, destPath);
  } catch (err) {
    try {
      fsImpl.unlinkSync(tmpPath);
    } catch {
      // best-effort cleanup only; the real failure is reported below
    }
    if (LOCK_CODES.has(err.code)) {
      const winHint =
        platform === "win32"
          ? " a running process has the addon loaded (an MCP client such as Claude Code running " +
            "dist/cli.js); stop it and re-run"
          : "";
      throw new ArtifactCopyError(
        `native build: failed to update ${destPath} (errno ${err.code});${winHint}`,
        { code: err.code, destPath },
      );
    }
    throw err;
  }
  return { action: "copied", destPath };
}
