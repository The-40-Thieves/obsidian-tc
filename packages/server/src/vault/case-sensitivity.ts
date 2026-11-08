// Per-vault filesystem case sensitivity. Whether two names differing only by case are the same
// file is a property of the VAULT'S filesystem, not of the process platform: macOS can sit on a
// case-sensitive APFS volume, Linux can mount a case-insensitive filesystem (WSL drvfs, exFAT,
// SMB, ext4 casefold), and Windows can mark a single directory case-sensitive. CASE_INSENSITIVE_FS
// (acl.ts) remains the platform default for vault-less callers; this module answers per vault
// root and says how to fail closed when the answer is unknowable.
import { randomUUID } from "node:crypto";
import { rmSync, type Stats, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { type AclCaseMatch, CASE_INSENSITIVE_FS } from "../acl";
import { resolveVaultPath } from "./paths";

/** `vaults[].caseSensitive`: "auto" (or absent) probes the vault root; true/false overrides it. */
export type CaseSensitiveSetting = "auto" | boolean;

/** What a vault's filesystem does with case, and what its ACL is compiled with. */
export interface VaultCaseInfo {
  /** The configured setting ("auto" when the key is absent). */
  readonly configured: CaseSensitiveSetting;
  /** The probe's answer; null when overridden or when the probe could not decide. */
  readonly detected: boolean | null;
  /** The effective fact (override, else probe); null = unknowable. */
  readonly caseInsensitive: boolean | null;
  /** The flags this vault's FolderAcl is compiled with (aclCaseMatchFor). */
  readonly match: AclCaseMatch;
}

const flipCase = (name: string): string =>
  name.replace(/[a-zA-Z]/g, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));

const isEnoent = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { code?: unknown }).code === "ENOENT";

function probeDir(root: string): boolean | null {
  // The temp-file probe answers for the root's OWN directory, the right fact where case
  // sensitivity is per-directory (NTFS's per-directory attribute, ext4 casefold): create a
  // mixed-case file and stat its case-flipped name.
  // resolveVaultPath, not a raw join: the probe is created and deleted inside the vault, so it
  // takes the same containment and symlink checks as any vault write/delete. A root that fails
  // the resolver (a planted symlink) makes the answer unknowable, not an exception.
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
    // Unwritable root (read-only vault) or the root vanished: fall through to the no-write probe.
  } finally {
    if (wrote) rmSync(probe, { force: true });
  }
  // No-write fallback: stat the root's own case-flipped name. dev+ino must match the root's, or
  // a genuinely DISTINCT sibling with the flipped name (case-sensitive fs) would read as a hit.
  const flipped = flipCase(basename(root));
  if (flipped === basename(root)) return null; // the name carries no case information
  let real: Stats;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- root is the configured vault root; probing it is this function's purpose.
    real = statSync(root);
  } catch {
    return null; // the root itself is unreachable: nothing is knowable
  }
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the vault root's own name, case-flipped, in its parent; read-only stat.
    const other = statSync(join(dirname(root), flipped));
    return real.dev === other.dev && real.ino === other.ino;
  } catch (e) {
    return isEnoent(e) ? false : null;
  }
}

// Memoized per root: detection is registration-time configuration, and every consumer (registry,
// acl-build, vault identity, compact) must agree within a process. A vault remounted onto a
// different filesystem is picked up on restart, like the ACL's other registration-time facts.
const probeCache = new Map<string, boolean | null>();

/** Whether `root`'s filesystem treats case-variant names as the same file; null when the probe
 *  cannot decide (the root is missing, unreadable and unwritable, or its name carries no case). */
export function detectFsCaseSensitivity(root: string): boolean | null {
  const cached = probeCache.get(root);
  if (cached !== undefined) return cached;
  const detected = probeDir(root);
  probeCache.set(root, detected);
  return detected;
}

/** The FolderAcl compile flags for a known-or-unknown filesystem. true/false: both sides follow
 *  the filesystem. null (detection failed): SPLIT — allow-side whitelists case-sensitive, rule
 *  scopes and immutable globs case-insensitive. That is the one posture a wrong guess cannot
 *  bypass: whitelists can only UNDER-match (deny a legitimate path) while scopes and immutability
 *  can only OVER-apply (demand a scope, or refuse a write, a path did not need). A uniform guess
 *  fails open on one side or the other. */
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
      caseInsensitive: configured,
      match: { allow: configured, rules: configured },
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
