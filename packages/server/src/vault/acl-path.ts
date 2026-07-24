import { type Stats, statSync } from "node:fs";
import { err, grantsAll } from "@the-40-thieves/obsidian-tc-shared";
// Per-path ACL enforcement — activates the dormant M0 FolderAcl seam.
// Every path-based tool calls this with the operation kind and the resolved
// vault-relative path. Membership is "matches at least one glob in the op's
// whitelist"; an omitted whitelist means that op kind is unrestricted (M0
// back-compat). THE-414: this is now enforced BOTH centrally in dispatch (via each
// tool's declarative pathAcl extractor, runDispatch calls enforcePathAcl before the
// handler) AND here at the handler level as defense-in-depth. The M0 dispatch
// read-only kill switch (forbidden) fires first for scope-mutating tools.
import { type FolderAcl, globMatch, isDefaultDenied } from "../acl";
import { recordAclCheck } from "./acl-audit";
import { resolveVaultPathChecked } from "./paths";

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
  // Hard default-deny baseline (THE-268): .obsidian/.git/.trash are unreachable for every op,
  // regardless of the allowlist (except the M3 config files in the exempt set).
  if (isDefaultDenied(path))
    return {
      allowed: false,
      deniedBy: `${op}_paths` as "read_paths" | "write_paths" | "delete_paths",
      matchedGlob: null,
    };
  if (op !== "read" && acl.readOnly)
    return { allowed: false, deniedBy: "read_only", matchedGlob: null };
  const list = op === "read" ? acl.readPaths : op === "write" ? acl.writePaths : acl.deletePaths;
  if (list === undefined) {
    // M0 back-compat: an undefined whitelist is unrestricted, UNLESS strictReadDefault fails the
    // read path closed (THE-268). strictReadDefault governs reads only.
    if (op === "read" && acl.strictReadDefault)
      return { allowed: false, deniedBy: "read_paths", matchedGlob: null };
    return { allowed: true, deniedBy: null, matchedGlob: null };
  }
  const matchedGlob = list.find((g) => globMatch(g, path)) ?? null;
  if (matchedGlob === null)
    return {
      allowed: false,
      deniedBy: `${op}_paths` as "read_paths" | "write_paths" | "delete_paths",
      matchedGlob: null,
    };
  return { allowed: true, deniedBy: null, matchedGlob };
}

/**
 * P1.4 (audit THE-562): are the scopes a path DECLARES (its last-match-winning rule scopes, or
 * defaultScopes when no rule matches) a subset of the caller's granted scopes? Pure — no filesystem.
 * A path whose effective scope set is empty (the shipped-config default: no rules, empty
 * defaultScopes) requires nothing, so this is a zero-cost `true` for configs that don't use
 * rule-scopes. Wildcard-aware via grantsAll (`*` / `read:*` satisfy). This makes the formerly
 * diagnostic-only scopesForPath an actual per-path authorization gate, alongside the readPaths/
 * writePaths/deletePaths allowlist (evaluatePathAcl) and the tool-level requiredScopes gate.
 */
export function pathScopesSatisfied(
  acl: FolderAcl | undefined,
  path: string,
  grantedScopes: Iterable<string>,
): boolean {
  if (!acl) return true;
  const required = acl.scopesForPath(path);
  return required.length === 0 || grantsAll(grantedScopes, required);
}

export function enforcePathAcl(
  acl: FolderAcl | undefined,
  op: AclOp,
  rel: string,
  root: string,
  // P1.4: when the central dispatch stage passes the caller's granted scopes, a path's declared
  // rule-scopes are enforced too. Omitted (undefined) by the ~120 handler-side defense-in-depth
  // calls, which stay folder-only — the central runDispatch stage is the authoritative scope gate.
  grantedScopes?: Iterable<string>,
): void {
  // THE-286: `root` is mandatory, so enforcement can never silently fall back to a lexical-only
  // check. We always gate on the REAL (symlink-resolved) vault-relative path (THE-269): an
  // in-vault symlink under an allowed folder whose target is a denied folder would otherwise pass
  // the ACL. For a non-symlink path the canonical form equals the lexical one (a no-op there).
  const resolved = resolveVaultPathChecked(root, rel);
  const path = resolved.aclRel;
  const decision = evaluatePathAcl(acl, op, path);
  if (!decision.allowed) {
    if (decision.deniedBy === "read_only")
      throw err.readOnlyMode(`vault is read-only; ${op} denied`, { path, op });
    throw err.aclDenied(`path is outside the ${op} whitelist`, { path, op });
  }
  // P1.4: rule-scopes are load-bearing. Checked on the RESOLVED path (so an in-vault symlink cannot
  // reach a scope-gated target through an unscoped folder), and only when the caller's scopes were
  // threaded in (the central dispatch stage). fail-closed: caller must hold the path's scope(s).
  if (grantedScopes !== undefined && !pathScopesSatisfied(acl, path, grantedScopes)) {
    throw err.aclDenied("caller lacks the scope(s) required for this path", {
      path,
      op,
      required_scopes: acl?.scopesForPath(path) ?? [],
    });
  }
  // THE-414 / #280: this path passed its folder-ACL check; record it for the (default-off) ACL
  // audit so a handler that later resolves an UNdeclared path for an fs op is caught in dev/test.
  recordAclCheck(path);
  // Inode-aliasing guard (C-1b): when an ACL is present (so .obsidian/.git/.trash and any path
  // whitelist are enforced), reject a hard-linked regular file. realpath cannot dereference a
  // hard link, so an aliased target outside the allowed set would otherwise pass the glob check.
  // The fd-based readers (notes-io) reject nlink>1 on read; this additionally covers delete/move,
  // which do not read through readNote. Fail closed; a not-yet-created write path has no stat.
  if (acl) {
    let st: Stats | null = null;
    try {
      st = statSync(resolved.abs);
    } catch {
      st = null;
    }
    if (st?.isFile() && st.nlink > 1)
      throw err.aclDenied("refusing a hard-linked file (inode aliasing)", { path, op });
  }
}
