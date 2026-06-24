import { err } from "@the-40-thieves/obsidian-tc-shared";
// Per-path ACL enforcement — activates the dormant M0 FolderAcl seam.
// Every path-based tool calls this with the operation kind and the resolved
// vault-relative path. Membership is "matches at least one glob in the op's
// whitelist"; an omitted whitelist means that op kind is unrestricted (M0
// back-compat). This is the handler-level layer; the M0 dispatch read-only
// kill switch (forbidden) fires first for scope-mutating tools.
import { type FolderAcl, globMatch } from "../acl";

export type AclOp = "read" | "write" | "delete";

export type PathAclDecision =
  | { allowed: true; deniedBy: null; matchedGlob: string | null }
  | {
      allowed: false;
      deniedBy: "read_only" | "read_paths" | "write_paths" | "delete_paths";
      matchedGlob: string | null;
    };

/**
 * Non-throwing mirror of enforcePathAcl: the same read-only-kill-switch + per-op
 * whitelist decision, returned instead of thrown. inspect_acl consumes this so the
 * diagnostic can never drift from live enforcement (which delegates here).
 */
export function evaluatePathAcl(
  acl: FolderAcl | undefined,
  op: AclOp,
  path: string,
): PathAclDecision {
  if (!acl) return { allowed: true, deniedBy: null, matchedGlob: null };
  if (op !== "read" && acl.readOnly)
    return { allowed: false, deniedBy: "read_only", matchedGlob: null };
  const list = op === "read" ? acl.readPaths : op === "write" ? acl.writePaths : acl.deletePaths;
  if (list === undefined) return { allowed: true, deniedBy: null, matchedGlob: null };
  const matchedGlob = list.find((g) => globMatch(g, path)) ?? null;
  if (matchedGlob === null)
    return {
      allowed: false,
      deniedBy: `${op}_paths` as "read_paths" | "write_paths" | "delete_paths",
      matchedGlob: null,
    };
  return { allowed: true, deniedBy: null, matchedGlob };
}

export function enforcePathAcl(acl: FolderAcl | undefined, op: AclOp, path: string): void {
  const decision = evaluatePathAcl(acl, op, path);
  if (decision.allowed) return;
  if (decision.deniedBy === "read_only")
    throw err.readOnlyMode(`vault is read-only; ${op} denied`, { path, op });
  throw err.aclDenied(`path is outside the ${op} whitelist`, { path, op });
}
