// Per-vault filesystem case sensitivity. Whether two names differing only by case are the same
// file is a property of the VAULT'S filesystem, not of the process platform: macOS can sit on a
// case-sensitive APFS volume, Linux can mount a case-insensitive filesystem (WSL drvfs, exFAT,
// SMB, ext4 casefold), and Windows can mark a single directory case-sensitive. CASE_INSENSITIVE_FS
// (acl.ts) remains the platform default for vault-less callers; this module answers per vault
// root, and pathCaseFolding answers per path for the directories the root probe cannot speak for.
import { randomUUID } from "node:crypto";
import { type BigIntStats, lstatSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type AclCaseMatch, CASE_INSENSITIVE_FS } from "../acl";
import { resolveVaultPath } from "./paths";

/** `vaults[].caseSensitive`: "auto" (or absent) probes the vault root; true = the filesystem
 *  distinguishes case, false = it folds case (the same sense as APFS "Case-sensitive", NTFS
 *  setCaseSensitiveInfo and Samba's `case sensitive`). */
export type CaseSensitiveSetting = "auto" | boolean;

/** What a vault's filesystem does with case, and what its ACL is compiled with. */
export interface VaultCaseInfo {
  /** The configured setting ("auto" when the key is absent). */
  readonly configured: CaseSensitiveSetting;
  /** The probe's answer (true = folds); null when overridden or when the probe could not decide. */
  readonly detected: boolean | null;
  /** The effective fact (override, else probe); null = unknowable. */
  readonly caseInsensitive: boolean | null;
  /** The flags this vault's FolderAcl is compiled with (aclCaseMatchFor). */
  readonly match: AclCaseMatch;
}

const flipCase = (name: string): string =>
  name.replace(/[a-zA-Z]/g, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));

const errCode = (e: unknown): unknown =>
  typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
const isEnoent = (e: unknown): boolean => errCode(e) === "ENOENT";

const sameEntry = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino;

/** Read-only probe: look an entry the directory already holds up under its case-flipped name. The
 *  lookup happens IN `dir`, so it describes `dir`'s own behavior (not its parent's). */
function probeByExistingEntry(dir: string): boolean | null {
  let names: string[];
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- dir is the configured vault root; listing it is the probe.
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const name = names.find((n) => flipCase(n) !== n);
  if (name === undefined) return null; // nothing in it carries case information
  const flipped = flipCase(name);
  if (names.includes(flipped)) return false; // two entries differing only by case coexist
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- an entry the vault root itself listed; read-only lstat.
    const real = lstatSync(join(dir, name), { bigint: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- that entry's case-flipped name in the same directory; read-only lstat.
    return sameEntry(real, lstatSync(join(dir, flipped), { bigint: true }));
  } catch (e) {
    return isEnoent(e) ? false : null;
  }
}

function probeDir(root: string): boolean | null {
  // The temp-file probe answers for the root's OWN directory: create a mixed-case file and stat its
  // case-flipped name. resolveVaultPath, not a raw join: the probe is created and deleted inside
  // the vault, so it takes the same containment and symlink checks as any vault write/delete. A
  // root that fails the resolver (a planted symlink) makes the answer unknowable, not an exception.
  let probe: string;
  try {
    probe = resolveVaultPath(root, `.obtc-CaSe-${process.pid}-${randomUUID()}`);
  } catch {
    return null;
  }
  let wrote = false;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- probe comes from resolveVaultPath (contained in the vault root); wx never overwrites.
    writeFileSync(probe, "", { flag: "wx", mode: 0o600 });
    wrote = true;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- the case-flipped name of the probe just created inside the vault root.
      statSync(join(root, flipCase(basename(probe))));
      return true;
    } catch (e) {
      return isEnoent(e) ? false : null;
    }
  } catch {
    // Unwritable root (read-only vault) or the root vanished: fall through to the read-only probe.
  } finally {
    if (wrote) rmSync(probe, { force: true });
  }
  return probeByExistingEntry(root);
}

// Memoized per root: detection is registration-time configuration, and every consumer (registry,
// acl-build, vault identity, compact) must agree within a process. A vault remounted onto a
// different filesystem is picked up on restart, like the ACL's other registration-time facts.
const probeCache = new Map<string, boolean | null>();

/** Whether `root`'s filesystem treats case-variant names as the same file; null when the probe
 *  cannot decide (the root is missing, unwritable and holds no entry with letters in its name). */
export function detectFsCaseSensitivity(root: string): boolean | null {
  const cached = probeCache.get(root);
  if (cached !== undefined) return cached;
  const detected = probeDir(root);
  probeCache.set(root, detected);
  return detected;
}

/** Whether `dir` folds case for lookups of `seg`: `seg` and its case-flipped name reach the same
 *  entry. undefined when `seg` is not in `dir` (the caller probes `dir` another way). */
function foldsFor(dir: string, seg: string): boolean | null | undefined {
  const flipped = flipCase(seg);
  if (flipped === seg) return probeByExistingEntry(dir);
  let entry: BigIntStats;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a single plain segment (no "..") inside a directory under the vault root.
    entry = lstatSync(join(dir, seg), { bigint: true });
  } catch (e) {
    return isEnoent(e) ? undefined : null;
  }
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the same segment case-flipped, in the same directory.
    return sameEntry(entry, lstatSync(join(dir, flipped), { bigint: true }));
  } catch (e) {
    return isEnoent(e) ? false : null;
  }
}

/**
 * How the directories vault-relative `rel` passes through treat case, asked of each directory in
 * turn (NTFS and ext4 casefold set it per directory, so the root's answer does not carry over):
 * true when every one folds, false when every one distinguishes case, null when they are mixed,
 * when one cannot be probed, or when the path runs into directories that do not exist yet (their
 * behavior is unknown until they are created). Callers take the restrictive answer on null.
 */
export function pathCaseFolding(root: string, rel: string): boolean | null {
  const segments = rel.normalize("NFC").split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return null;
  let all: boolean | undefined;
  let dir = root;
  for (const [i, seg] of segments.entries()) {
    const here = foldsFor(dir, seg);
    const folds = here === undefined ? probeByExistingEntry(dir) : here;
    if (folds === null || (all !== undefined && folds !== all)) return null;
    all = folds;
    // A missing segment ends the walk: what lies under it does not exist, so nothing can be known.
    if (here === undefined) return i === segments.length - 1 ? all : null;
    dir = join(dir, seg);
  }
  return all ?? null;
}
/** The FolderAcl compile flags for a known-or-unknown filesystem (true = folds). They govern only
 *  an ACL that cannot ask the filesystem (no vault root): a vault's own FolderAcl settles every
 *  case-only match through pathCaseFolding. null: allow-lists exact-case, rule scopes and immutable
 *  globs folded, the posture a wrong guess cannot bypass. */
export function aclCaseMatchFor(caseInsensitive: boolean | null): AclCaseMatch {
  if (caseInsensitive === true) return { allow: true, rules: true };
  if (caseInsensitive === false) return { allow: false, rules: false };
  return { allow: false, rules: true };
}

/** One vault's resolution: the override wins; "auto"/absent probes the (canonical) root. A vault
 *  with no path to probe is unknowable, and gets the fail-closed split like a failed probe. */
export function vaultCaseInfo(
  root: string | undefined,
  configured: CaseSensitiveSetting | undefined,
  detect: typeof detectFsCaseSensitivity = detectFsCaseSensitivity,
): VaultCaseInfo {
  if (configured !== undefined && configured !== "auto")
    return {
      configured,
      detected: null,
      caseInsensitive: !configured,
      match: aclCaseMatchFor(!configured),
    };
  const detected = root === undefined ? null : detect(root);
  return {
    configured: "auto",
    detected,
    caseInsensitive: detected,
    match: aclCaseMatchFor(detected),
  };
}

/** Case-fold decision for the wiki/raw CLASSIFICATION helpers (wiki-folder.ts) — not an
 *  authorization boundary. undefined (a view built without the fact, e.g. a test fixture) keeps
 *  the platform default; null (detection failed) folds, because over-classifying a path as raw or
 *  generated only ever EXCLUDES it from wiki scans, lint and the judge, never wrongly includes
 *  one. The read/write gates themselves are the FolderAcl (compiled per vault) and the
 *  inode-identity checks, neither of which consults this. */
export function classificationFold(caseInsensitive: boolean | null | undefined): boolean {
  if (caseInsensitive === undefined) return CASE_INSENSITIVE_FS;
  return caseInsensitive ?? true;
}
