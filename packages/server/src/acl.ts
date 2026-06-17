// Glob folder ACL, last-match-wins (G2.4 A.2).
export interface AclRuleT {
  glob: string;
  scopes: string[];
}
export interface AclConfigT {
  readOnly: boolean;
  defaultScopes: string[];
  rules: AclRuleT[];
}

const NUL = " ";

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
}
