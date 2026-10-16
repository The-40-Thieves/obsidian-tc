// Which file an open descriptor names, for the JS-fallback read's post-open check. Linux asks procfs.
// macOS asks `/dev/fd/N`, but only after a probe shows that path names the opened file. Windows has
// no answer: Node has no API for a handle's final path (GetFinalPathNameByHandle needs FFI), and the
// native safe I/O is Unix-only, so neither backend checks the descriptor's path there. The ancestor
// re-walk is the only check on Windows.
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

/**
 * What an open descriptor names. `none`: this platform cannot say, so the ancestor re-walk runs.
 * `failed`: the platform can say, but this lookup could not, so the read is refused. `path`: the
 * named file; `folded` means macOS spelling rules apply when comparing it (see matchesOpenedPath).
 */
export type OpenedFdPath =
  | { kind: "none" }
  | { kind: "failed" }
  | { kind: "path"; path: string; folded: boolean };

type FdPathResolver = (fd: number) => OpenedFdPath;

let fdPathOverride: FdPathResolver | undefined;

/** Test seam, not a public API: replaces the platform resolver for later opens. */
export function setOpenedFdPathResolverForTest(resolver: FdPathResolver | undefined): void {
  fdPathOverride = resolver;
}

// procfs is optional: a failed lookup is "unknown", and the ancestor re-walk runs instead.
const procFdPath: FdPathResolver = (fd) => {
  try {
    return { kind: "path", path: normalize(readlinkSync(`/proc/self/fd/${fd}`)), folded: false };
  } catch {
    return { kind: "none" };
  }
};

// Once the probe has passed, a lookup that throws is a failure, not "unknown": see lookupOpenedFdPath.
const devFdPath: FdPathResolver = (fd) => ({
  kind: "path",
  path: realpathSync.native(`/dev/fd/${fd}`),
  folded: true,
});

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

// Windows has no resolver here (see the module comment), so it keeps the ancestor re-walk.
function platformFdPathResolver(): FdPathResolver | undefined {
  if (process.platform === "linux") return procFdPath;
  if (process.platform === "darwin") return devFdNamesFile() ? devFdPath : undefined;
  return undefined;
}

/** What the active resolver says about `fd`. A resolver that throws reports `failed`. */
export function lookupOpenedFdPath(fd: number): OpenedFdPath {
  const resolver = fdPathOverride ?? platformFdPathResolver();
  if (resolver === undefined) return { kind: "none" };
  try {
    return resolver(fd);
  } catch {
    return { kind: "failed" };
  }
}

/** Whether this platform can name an opened descriptor's file. Read by the no-follow tests. */
export function openedFdPathSupported(): boolean {
  return platformFdPathResolver() !== undefined;
}

// macOS volumes are often case-insensitive and may name a file in NFD where the caller used NFC.
// Only the folded (darwin) lookup ignores that; Linux compares exactly.
const foldSpelling = (path: string): string => path.normalize("NFC").toLowerCase();

/** Whether the descriptor's path is `expected`. A symlink escape still differs after folding. */
export function matchesOpenedPath(opened: { path: string; folded: boolean }, expected: string) {
  return opened.folded
    ? foldSpelling(opened.path) === foldSpelling(expected)
    : opened.path === expected;
}

/** The path an open descriptor must name for `path`: `path` spelled under its canonical root. The
 *  caller takes this BEFORE the ancestor walk, so a component swapped in after the walk cannot shape
 *  it. Undefined when the root cannot be resolved; the walk then reports the root's own error. */
export function expectedOpenedPath(path: string): string | undefined {
  const knownRoot = folderRootForSink(path);
  if (knownRoot === undefined) return path;
  try {
    return join(realpathSync.native(knownRoot), relative(knownRoot, path));
  } catch {
    return undefined;
  }
}
