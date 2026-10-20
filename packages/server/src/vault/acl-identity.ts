// The ACL identity as a type. A read ACL judges the symlink-resolved, vault-relative target of a path,
// never the name a caller or a walk showed. Branding that target means a display name cannot reach a
// predicate that decides on identity: the compiler refuses a plain string where an AclPath is required.
declare const aclPathBrand: unique symbol;

/** A vault-relative path that IS an ACL identity: the symlink-resolved target of a path, or the stored
 *  name of a row whose identity is itself (no symlink). Never a display name a walk or caller showed. */
export type AclPath = string & { readonly [aclPathBrand]: true };

/** The ONE mint. Only identity producers call it (vault/paths.ts, vault/stored-acl-path.ts);
 *  test/acl-path-brand.test.ts holds the call sites to that set. */
export function mintAclPath(identity: string): AclPath {
  return identity as AclPath;
}
