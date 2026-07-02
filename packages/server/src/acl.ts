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

export function globToRegExp(glob: string): RegExp {
  const withDouble = glob.replace(/\*\*/g, NUL);
  let re = "";
  for (const c of withDouble) {
    if (c === NUL) re += ".*";
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

// Match glob against path in a Unicode-normalization-insensitive way (THE-272). macOS stores
// filenames as NFD while a config/glob authored elsewhere is almost always NFC; without normalizing
// both sides, an NFC deny/whitelist rule silently fails to match its NFD path on disk (a deny that
// does not deny, or an allow that wrongly denies). Normalizing both to NFC makes the ACL decide on
// the logical name, not its byte form.
export function globMatch(glob: string, path: string): boolean {
  return globToRegExp(glob.normalize("NFC")).test(path.normalize("NFC"));
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
  return DEFAULT_DENY_ROOTS.some((r) => p === r || p.startsWith(`${r}/`));
}

export class FolderAcl {
  constructor(private readonly cfg: AclConfigT) {}
  scopesForPath(path: string): string[] {
    let scopes = this.cfg.defaultScopes;
    for (const r of this.cfg.rules) {
      if (globMatch(r.glob, path)) scopes = r.scopes;
    }
    return scopes;
  }
  get readOnly(): boolean {
    return this.cfg.readOnly;
  }
  get readPaths(): string[] | undefined {
    return this.cfg.readPaths;
  }
  get strictReadDefault(): boolean {
    return this.cfg.strictReadDefault === true;
  }
  get writePaths(): string[] | undefined {
    return this.cfg.writePaths;
  }
  get deletePaths(): string[] | undefined {
    return this.cfg.deletePaths;
  }
}
