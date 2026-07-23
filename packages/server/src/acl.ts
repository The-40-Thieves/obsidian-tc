import { createHash } from "node:crypto";

// Glob folder ACL, last-match-wins (G2.4 A.2).
export interface AclRuleT {
  glob: string;
  scopes: string[];
}
export interface AclConfigT {
  readOnly: boolean;
  defaultScopes: string[];
  rules: AclRuleT[];
  // Per-path operation whitelists (membership = matches at least one glob).
  // Undefined = unrestricted for that op kind (M0 back-compat).
  readPaths?: string[];
  writePaths?: string[];
  deletePaths?: string[];
  /** When true, an UNDEFINED readPaths whitelist denies blanket read enumeration
   *  (bridge tools must produce path-attributable results) instead of allowing all.
   *  Default false = M0 allow-all (D2 hardening). */
  strictReadDefault?: boolean;
}

// Sentinel for the `**` token. A NUL char (illegal in any vault-relative path)
// so it can never alias real input: vault paths routinely contain literal spaces,
// which a space sentinel mis-compiled to `.*` and over-matched across `/`.
const NUL = String.fromCharCode(0);

// On a case-insensitive filesystem (Windows NTFS, macOS APFS) a path and its case variants name the
// SAME file, so the folder ACL must match case-insensitively there or a case-variant path slips past
// a whitelist/deny authored in canonical case (THE-272). On a case-sensitive filesystem (Linux) case
// is significant and matching stays exact. Detected once from the platform; overridable for tests.
const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";

// Upper bound on a single glob. Every path check compiles its globs, so an unbounded pattern is
// wasted work on the hot path at best; the limit also keeps a malformed or generated config from
// producing a pathological regex. Real vault globs are far below this — the hardened example's
// longest is under 20 chars — so the ceiling is deliberately generous and never trips in practice.
const MAX_GLOB_LENGTH = 512;

export function globToRegExp(glob: string, caseInsensitive: boolean = CASE_INSENSITIVE_FS): RegExp {
  if (glob.length > MAX_GLOB_LENGTH)
    throw new Error(`glob too long (${glob.length} > ${MAX_GLOB_LENGTH})`);
  const withDouble = glob.replace(/\*\*/g, NUL);
  let re = "";
  for (const c of withDouble) {
    if (c === NUL) re += ".*";
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, caseInsensitive ? "i" : "");
}

// Match glob against path in a Unicode-normalization-insensitive way (THE-272). macOS stores
// filenames as NFD while a config/glob authored elsewhere is almost always NFC; without normalizing
// both sides, an NFC deny/whitelist rule silently fails to match its NFD path on disk (a deny that
// does not deny, or an allow that wrongly denies). Normalizing both to NFC makes the ACL decide on
// the logical name, not its byte form.
export function globMatch(
  glob: string,
  path: string,
  caseInsensitive: boolean = CASE_INSENSITIVE_FS,
): boolean {
  return globToRegExp(glob.normalize("NFC"), caseInsensitive).test(path.normalize("NFC"));
}

// Hard default-deny baseline (THE-268): the Obsidian/VCS control directories are never reachable
// through the folder ACL, regardless of the allowlist, for read/write/delete — `.obsidian/plugins/
// */data.json` routinely holds plugin API keys and Obsidian Sync passwords. The two config files
// the M3 bookmark/workspace tools legitimately touch are exempted so those tools keep working.
const DEFAULT_DENY_ROOTS = [".obsidian", ".git", ".trash"];
const DEFAULT_DENY_EXEMPT: ReadonlySet<string> = new Set([
  ".obsidian/bookmarks.json",
  ".obsidian/workspaces.json",
]);

/** True when a vault-relative path is under a hard-denied control directory (and not exempt). */
export function isDefaultDenied(path: string): boolean {
  const p = path.normalize("NFC"); // THE-272: decide on the logical name, not its NFC/NFD byte form
  if (DEFAULT_DENY_EXEMPT.has(p)) return false;
  // Case-fold the control-directory match: `.obsidian`/`.git`/`.trash` must be denied under EVERY
  // case variant, because on a case-insensitive filesystem `.Obsidian` and `.obsidian` are the same
  // directory on disk (THE-272). The roots are ASCII and this only ever denies MORE, never exempts,
  // so it is safe on a case-sensitive filesystem too. The exempt check above stays exact so a
  // mis-cased path can never be wrongly exempted where case is significant.
  const lower = p.toLowerCase();
  return DEFAULT_DENY_ROOTS.some((r) => lower === r || lower.startsWith(`${r}/`));
}

export class FolderAcl {
  constructor(private readonly cfg: AclConfigT) {}
  // Every accessor below returns a COPY. A FolderAcl is built once per vault and shared across all
  // dispatches, so handing back the live config array would let any caller that mutates it rewrite
  // the ACL for every subsequent call — a privilege escalation with no trace in the config file.
  scopesForPath(path: string): string[] {
    let scopes = this.cfg.defaultScopes;
    for (const r of this.cfg.rules) {
      if (globMatch(r.glob, path)) scopes = r.scopes;
    }
    return [...scopes];
  }
  get readOnly(): boolean {
    return this.cfg.readOnly;
  }
  get readPaths(): string[] | undefined {
    return this.cfg.readPaths ? [...this.cfg.readPaths] : undefined;
  }
  get strictReadDefault(): boolean {
    return this.cfg.strictReadDefault === true;
  }
  get writePaths(): string[] | undefined {
    return this.cfg.writePaths ? [...this.cfg.writePaths] : undefined;
  }
  get deletePaths(): string[] | undefined {
    return this.cfg.deletePaths ? [...this.cfg.deletePaths] : undefined;
  }
  /** THE-496: the fingerprint of THIS vault's effective ACL for a caller holding `grantedScopes`. */
  fingerprint(grantedScopes: Iterable<string>): string {
    return aclFingerprint(this.cfg, grantedScopes);
  }
}

// THE-496 — a stable, deterministic fingerprint of the EFFECTIVE ACL for a caller/vault. This is the
// SECURITY-CRITICAL half of the query-cache key: it is the only thing that keeps caller A's cached
// results from reaching caller B. The read predicate (readableRel / scopesForPath) is a pure function
// of the ACL CONFIG + the caller's granted SCOPES, so identical (config, scopes) provably yield the
// identical read set -> a shared cache entry is safe; any difference yields a different fingerprint
// -> no sharing (safe, at worst over-conservative). No vault walk, so it is cheap on the hot path.
//
// Canonicalisation is exact: sets are sorted (defaultScopes, each rule's scopes, the path whitelists,
// the caller's scopes), but the RULES ARRAY ORDER IS PRESERVED — scopesForPath is last-match-wins, so
// reordering rules changes the effective ACL and MUST change the fingerprint.
export function aclFingerprint(cfg: AclConfigT, grantedScopes: Iterable<string>): string {
  const canon = {
    readOnly: cfg.readOnly === true,
    strictReadDefault: cfg.strictReadDefault === true,
    defaultScopes: [...cfg.defaultScopes].sort(),
    // order-preserving: [ruleA, ruleB] != [ruleB, ruleA] under last-match-wins
    rules: cfg.rules.map((r) => ({ glob: r.glob, scopes: [...r.scopes].sort() })),
    readPaths: cfg.readPaths ? [...cfg.readPaths].sort() : null,
    writePaths: cfg.writePaths ? [...cfg.writePaths].sort() : null,
    deletePaths: cfg.deletePaths ? [...cfg.deletePaths].sort() : null,
    scopes: [...new Set(grantedScopes)].sort(),
  };
  return createHash("sha256").update(JSON.stringify(canon), "utf8").digest("hex");
}

/**
 * THE-453: build the indexing read-visibility predicate factory. Resolves the EFFECTIVE ACL per
 * vault (per-vault override, falling back to the root default) — the same resolution the dispatch
 * aclResolver does — so a vault's readPaths/strictReadDefault override is honored at INDEXING time,
 * not just at retrieval. Closing over the root ACL for every vault let a path a vault-override
 * DENIES still be read, embedded and sent to the embedding provider (an ingestion-time
 * confidentiality breach retrieval-time filtering cannot undo), and let a restrictive root wrongly
 * block a path a vault-override permits.
 */
export function makeIndexReadable(
  rootAcl: FolderAcl,
  aclByVault: Map<string, FolderAcl>,
): (vaultId: string) => (rel: string) => boolean {
  return (vaultId) => (rel) => {
    const a = aclByVault.get(vaultId) ?? rootAcl;
    if (isDefaultDenied(rel)) return false;
    // Read the whitelist ONCE: the accessor returns a defensive copy and this predicate runs per
    // note for a whole vault, so a second read would allocate a second copy for nothing.
    const readPaths = a.readPaths;
    if (readPaths === undefined) return a.strictReadDefault !== true;
    return readPaths.some((g) => globMatch(g, rel));
  };
}

/** THE-453 runtime counterpart: the write sink an index-on-write gate feeds. */
export interface ReindexSink {
  write(vaultId: string, path: string, content: string): void;
  delete(vaultId: string, path: string): void;
}

/**
 * THE-453 (runtime): build the index-on-write hook that honors the EFFECTIVE read ACL, mirroring the
 * boot reconcile's indexReadableFor. A path can be write-allowed but read-DENIED (writePaths ⊃
 * readPaths); a write handler passes the write ACL and then calls this hook. Without the read gate
 * the content is chunked, embedded and shipped to the embedding provider despite being read-invisible
 * — an ingestion-time confidentiality breach that retrieval-time filtering cannot undo. A denied path
 * routes to `delete` instead of `write`, so an ACL that newly denies a previously-indexed path also
 * EVICTS its stale chunks/vectors rather than stranding them.
 */
export function makeReindexGate(
  indexReadableFor: (vaultId: string) => (rel: string) => boolean,
  sink: ReindexSink,
): (vaultId: string, path: string, content: string) => void {
  return (vaultId, path, content) => {
    if (indexReadableFor(vaultId)(path)) sink.write(vaultId, path, content);
    else sink.delete(vaultId, path);
  };
}
