// Creating a symlink needs a privilege Windows does not grant by default (Developer Mode or an
// elevated shell), so symlink cases are skipped by CAPABILITY, not by platform: CI's Windows
// runners can create them and keep the coverage. Under CI an incapable host is an error rather
// than a skip, so a runner that loses the privilege cannot silently drop that coverage.
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function resolveSymlinkSupport(
  tryCreate: () => void,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    tryCreate();
    return true;
  } catch (e) {
    if (env.CI) throw new Error(`CI host cannot create symlinks: ${String(e)}`);
    return false;
  }
}

function probe(): void {
  const dir = mkdtempSync(join(tmpdir(), "obtc-symlink-probe-"));
  try {
    writeFileSync(join(dir, "f"), "");
    symlinkSync(join(dir, "f"), join(dir, "file-link"), "file");
    symlinkSync(dir, join(dir, "dir-link"), "dir");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Whether this host can create file and directory symlinks. */
export const SYMLINKS_SUPPORTED = resolveSymlinkSupport(probe);
