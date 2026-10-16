// Which file an open descriptor names, for the JS-fallback read's post-open check. Linux asks procfs.
// macOS asks `/dev/fd/N`, but only after a probe shows that path names the opened file. Windows has
// no answer: Node has no API for a handle's final path (GetFinalPathNameByHandle needs FFI), so the
// ancestor re-walk stays the check there and the native backend is the Windows defence.
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  openSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize, relative } from "node:path";
import { folderRootForSink } from "./folder-links";

/** Names the file an open descriptor refers to, or undefined when this platform cannot say. */
type FdPathResolver = (fd: number) => string | undefined;

let fdPathOverride: FdPathResolver | undefined;

/** Test seam, not a public API: replaces the platform resolver for later opens. */
export function setOpenedFdPathResolverForTest(resolver: FdPathResolver | undefined): void {
  fdPathOverride = resolver;
}

// procfs is optional: a failed lookup is "unknown", and the ancestor re-walk runs instead.
const procFdPath: FdPathResolver = (fd) => {
  try {
    return normalize(readlinkSync(`/proc/self/fd/${fd}`));
  } catch {
    return undefined;
  }
};

const devFdPath: FdPathResolver = (fd) => {
  try {
    return realpathSync.native(`/dev/fd/${fd}`);
  } catch {
    return undefined;
  }
};

let devFdProbe: boolean | undefined;

/** macOS does not document whether `realpath(/dev/fd/N)` names the opened file or just echoes the
 *  descriptor path. Probe once per process on a scratch file whose path is known. Never throws. */
function devFdNamesFile(): boolean {
  if (devFdProbe !== undefined) return devFdProbe;
  devFdProbe = false;
  const file = join(tmpdir(), `otc-fd-probe-${randomBytes(8).toString("hex")}`);
  let fd: number | undefined;
  try {
    writeFileSync(file, "");
    fd = openSync(file, constants.O_RDONLY);
    const viaFd = realpathSync.native(`/dev/fd/${fd}`);
    devFdProbe = viaFd === realpathSync.native(file) && !viaFd.startsWith("/dev/fd/");
  } catch {
    devFdProbe = false;
  } finally {
    try {
      if (fd !== undefined) closeSync(fd);
      rmSync(file, { force: true });
    } catch {
      // Scratch cleanup only: the verdict above is already decided.
    }
  }
  return devFdProbe;
}

// Windows has no Node API for a handle's final path (GetFinalPathNameByHandle needs FFI), so it
// has no resolver here and the re-walk stays the check; the native backend is the Windows defence.
function platformFdPathResolver(): FdPathResolver | undefined {
  if (process.platform === "linux") return procFdPath;
  if (process.platform === "darwin") return devFdNamesFile() ? devFdPath : undefined;
  return undefined;
}

export function openedFdPathResolver(): FdPathResolver | undefined {
  return fdPathOverride ?? platformFdPathResolver();
}

/** Whether this platform can name an opened descriptor's file. Read by the no-follow tests. */
export function openedFdPathSupported(): boolean {
  return platformFdPathResolver() !== undefined;
}

/** The path an open descriptor must name for `path`: `path` spelled under its canonical root. The
 *  caller takes this BEFORE the ancestor walk, so a component swapped in after the walk cannot shape it. */
export function expectedOpenedPath(path: string): string {
  const knownRoot = folderRootForSink(path);
  return knownRoot === undefined
    ? path
    : join(realpathSync.native(knownRoot), relative(knownRoot, path));
}
