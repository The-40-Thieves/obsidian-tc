import { err } from "@obsidian-tc/shared";
// Per-path ACL enforcement — activates the dormant M0 FolderAcl seam.
// Every path-based tool calls this with the operation kind and the resolved
// vault-relative path. Membership is "matches at least one glob in the op's
// whitelist"; an omitted whitelist means that op kind is unrestricted (M0
// back-compat). This is the handler-level layer; the M0 dispatch read-only
// kill switch (forbidden) fires first for scope-mutating tools.
import { type FolderAcl, globMatch } from "../acl";

export type AclOp = "read" | "write" | "delete";

export function enforcePathAcl(acl: FolderAcl | undefined, op: AclOp, path: string): void {
  if (!acl) return;
  if (op !== "read" && acl.readOnly)
    throw err.readOnlyMode(`vault is read-only; ${op} denied`, { path, op });
  const list = op === "read" ? acl.readPaths : op === "write" ? acl.writePaths : acl.deletePaths;
  if (list === undefined) return; // unrestricted for this op kind
  if (!list.some((g) => globMatch(g, path)))
    throw err.aclDenied(`path is outside the ${op} whitelist`, { path, op });
}
