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

export function globMatch(glob: string, path: string): boolean {
  return globToRegExp(glob).test(path);
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
