// Filesystem trust for signing-key files under `<cacheDir>/auth-keys/`.
//
// A key file is trusted only when we can show, on the OPEN file descriptor, that it is a regular
// file we own that no group/other principal can read, reached without following a symlink, inside a
// real directory that is itself ours and 0700. The check is repeated on every read (see the
// registry: no secret is cached), so a `chmod` made after startup is noticed on the next verify.
//
// Why descriptor-based: `stat(path)` then `readFile(path)` are two lookups, and `stat` follows
// symlinks, so a link to a 0600 file passes the first and the bytes of the link TARGET become the
// HMAC key. `open(O_NOFOLLOW)` refuses the link, and `fstat(fd)` describes the exact inode we then
// read from.
//
// Windows has no POSIX mode bits, no O_NOFOLLOW and no uid: none of this can be enforced there, and
// `KEY_FILE_TRUST_ENFORCED` says so, for `doctor` to report instead of a silent skip.
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

/** False on Windows: mode, owner and symlink checks below are not enforceable there. */
export const KEY_FILE_TRUST_ENFORCED = process.platform !== "win32";

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const GROUP_OTHER = 0o077;

export class KeyFileError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "KeyFileError";
  }
}

const myUid = (): number | undefined =>
  typeof process.getuid === "function" ? process.getuid() : undefined;

function ownedByUs(st: { uid: number }, what: string): void {
  const uid = myUid();
  if (uid !== undefined && st.uid !== uid) {
    throw new KeyFileError(`${what} is owned by uid ${st.uid}, not the server's uid ${uid}`);
  }
}

/**
 * Check `dir` is a real directory (not a symlink), ours, and 0700. With `create`, a missing
 * directory is made 0700 and a too-open one is tightened; without it (the verify path, which must
 * not mutate anything) a too-open or missing directory is refused.
 */
export function ensureKeysDir(dir: string, opts: { create: boolean }): void {
  if (!KEY_FILE_TRUST_ENFORCED) {
    if (opts.create) mkdirSync(dir, { recursive: true });
    return;
  }
  let st = lstatOrUndefined(dir);
  if (st === undefined) {
    if (!opts.create) throw new KeyFileError(`${dir} does not exist`);
    mkdirSync(dirname(dir), { recursive: true });
    mkdirSync(dir, { mode: 0o700 });
    st = lstatSync(dir);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new KeyFileError(`${dir} must be a real directory, not a symlink or file`);
  }
  ownedByUs(st, dir);
  if ((st.mode & GROUP_OTHER) === 0) return;
  if (!opts.create) {
    throw new KeyFileError(`${dir} has mode ${modeStr(st.mode)}; it must be 0700`);
  }
  // Tighten through a descriptor opened without following links, so the chmod lands on the
  // directory we just inspected, not on whatever a racing rename put at the path.
  const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | NOFOLLOW);
  try {
    fchmodSync(fd, 0o700);
  } finally {
    closeSync(fd);
  }
}

function lstatOrUndefined(path: string) {
  try {
    return lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

const modeStr = (mode: number): string => `0${(mode & 0o777).toString(8)}`;

/**
 * Read a key file's secret, or throw `KeyFileError`. The parent directory is checked first
 * (`ensureKeysDir` without `create`), then the file is opened `O_RDONLY|O_NOFOLLOW` and judged by
 * `fstat` on that descriptor before a single byte is read from it.
 */
export function readKeyFile(path: string): string {
  ensureKeysDir(dirname(path), { create: false });
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  } catch (e) {
    throw new KeyFileError(
      `cannot open key file ${path} (${(e as NodeJS.ErrnoException).code ?? "error"})`,
      e,
    );
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new KeyFileError(`${path} is not a regular file`);
    if (KEY_FILE_TRUST_ENFORCED) {
      if ((st.mode & GROUP_OTHER) !== 0) {
        throw new KeyFileError(
          `${path} has mode ${modeStr(st.mode)}, readable by group/other; it must be 0600`,
        );
      }
      ownedByUs(st, path);
    }
    const secret = readFileSync(fd, "utf8").trim();
    if (secret === "") throw new KeyFileError(`${path} is empty`);
    return secret;
  } finally {
    closeSync(fd);
  }
}

/** Create `path` exclusively (`O_EXCL`), never through a symlink (`O_NOFOLLOW`), mode 0600. */
export function createKeyFile(path: string, contents: string): void {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
    0o600,
  );
  try {
    if (KEY_FILE_TRUST_ENFORCED) fchmodSync(fd, 0o600);
    writeSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Every `*.key` file name in `dir`; empty when the directory does not exist. */
export function keyFileNames(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".key"));
  } catch {
    return [];
  }
}

/** Does `path` exist, without following a final symlink? */
export function existsNoFollow(path: string): boolean {
  return lstatOrUndefined(path) !== undefined;
}
