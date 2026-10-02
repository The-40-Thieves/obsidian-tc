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
import { type FolderAcl, isDefaultDenied } from "../acl";
// GH #994 second security review, M1: `path` here is the caller-controlled (resolved but
// unscanned) target of the op — memoryDefense has not run yet at this point in dispatch, and for
// a hard-denied or whitelist-miss path this function is what throws. Sharing the same scanner
// every other raw-value echo in this codebase already uses (episode log, trace capture, ambient
// import, commit_capture's own defense-in-depth echoes) keeps this the ONE place a secret-shaped
// path gets redacted, rather than a second copy that could drift.
import { redactSecrets } from "../experiential/redact";
import { recordAclCheck } from "./acl-audit";
import { assertWritableVaultPath, normalizeVaultPath, resolveVaultPathChecked } from "./paths";

export type AclOp = "read" | "write" | "delete";

export type PathAclDecision =
  | { allowed: true; deniedBy: null; matchedGlob: string | null }
  | {
      allowed: false;
      deniedBy: "read_only" | "read_paths" | "write_paths" | "delete_paths";
      matchedGlob: string | null;
      /** Set when the path is under an immutable folder (a vault's raw sources), so the caller can
       *  say so instead of blaming a whitelist. */
      immutable?: true;
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
  if (op !== "read") {
    const immutable = acl.immutableGlobFor(path);
    if (immutable !== null)
      return {
        allowed: false,
        deniedBy: `${op}_paths` as "write_paths" | "delete_paths",
        matchedGlob: immutable,
        immutable: true,
      };
  }
  if (op !== "read" && acl.readOnly)
    return { allowed: false, deniedBy: "read_only", matchedGlob: null };
  // THE-618: match against the op's PRECOMPILED whitelist rather than re-reading a defensive copy
  // of it and recompiling/re-normalizing per glob. `undefined` = the op has no whitelist at all;
  // `null` = a whitelist exists and nothing in it matched. The two are different decisions.
  const matchedGlob = acl.matchedPathGlob(op, path);
  if (matchedGlob === undefined) {
    // M0 back-compat: an undefined whitelist is unrestricted, UNLESS strictReadDefault fails the
    // read path closed (THE-268). strictReadDefault governs reads only.
    if (op === "read" && acl.strictReadDefault)
      return { allowed: false, deniedBy: "read_paths", matchedGlob: null };
    return { allowed: true, deniedBy: null, matchedGlob: null };
  }
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
  // Fast path for the shipped config: nothing declares a scope, so nothing can be unsatisfied.
  if (!acl.declaresPathScopes) return true;
  const required = acl.scopesForPath(path);
  return required.length === 0 || grantsAll(grantedScopes, required);
}

export function enforcePathAcl(
  acl: FolderAcl | undefined,
  op: AclOp,
  rel: string,
  root: string,
  // P1.4: a path's declared rule-scopes are enforced against the caller's granted scopes. REQUIRED
  // (no default, not optional), like readableRel's: an optional parameter let ~120 handler-side calls
  // stay folder-only, so a rule-scoped note was refused by read_note yet returned by every handler
  // that forgot to thread scopes. A caller that omits it must fail to compile.
  grantedScopes: Iterable<string>,
): void {
  // THE-286: `root` is mandatory, so enforcement can never silently fall back to a lexical-only
  // check. We always gate on the REAL (symlink-resolved) vault-relative path (THE-269): an
  // in-vault symlink under an allowed folder whose target is a denied folder would otherwise pass
  // the ACL. For a non-symlink path the canonical form equals the lexical one (a no-op there).
  const resolved = resolveVaultPathChecked(root, rel);
  const path = resolved.aclRel;
  // A write that would CREATE a Windows-hostile name (`:`, trailing dot/space, reserved device
  // name) is refused before any ACL decision or side effect; existing names stay writable in place.
  // Checked on the LEXICAL request (the name the caller is about to create), not the realpath.
  if (op === "write") assertWritableVaultPath(root, rel);
  // GH #994 second security review, M1: every throw below carries `path` in its `details` for a
  // caller/operator to read back — but this function runs BEFORE memoryDefense (it gates the
  // write itself), so a secret-shaped `path` that also happens to be denied (hard-denied
  // .obsidian/.git/.trash, a whitelist miss, an unscoped path) must never echo the raw value back
  // through the error envelope. Redact once, reuse for every throw site in this function; `path`
  // itself stays unredacted for the real ACL/audit logic below (recordAclCheck, scopesForPath).
  const redactedPath = redactSecrets(path).text;
  const immutableDenied = (): never => {
    throw err.aclDenied(`path is in an immutable folder (raw sources); ${op} denied`, {
      path: redactedPath,
      op,
      reason: "immutable_folder",
    });
  };
  // An immutable folder is judged on the name as written AND on the real path: a symlink under it
  // that leads out (or one leading in) must not make a raw source writable.
  if (op !== "read" && acl?.immutableGlobFor(normalizeVaultPath(rel)) != null) immutableDenied();
  const decision = evaluatePathAcl(acl, op, path);
  if (!decision.allowed) {
    if (decision.immutable) immutableDenied();
    if (decision.deniedBy === "read_only")
      throw err.readOnlyMode(`vault is read-only; ${op} denied`, { path: redactedPath, op });
    throw err.aclDenied(`path is outside the ${op} whitelist`, { path: redactedPath, op });
  }
  // P1.4: rule-scopes are load-bearing. Checked on the RESOLVED path (so an in-vault symlink cannot
  // reach a scope-gated target through an unscoped folder), and only when the caller's scopes were
  // fail-closed: caller must hold the path's scope(s).
  if (!pathScopesSatisfied(acl, path, grantedScopes)) {
    throw err.aclDenied("caller lacks the scope(s) required for this path", {
      path: redactedPath,
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
      throw err.aclDenied("refusing a hard-linked file (inode aliasing)", {
        path: redactedPath,
        op,
      });
  }
}

/**
 * THE non-throwing read predicate for a path a stored row NAMES (a capture's target/committed note,
 * a memory entity's projection note): may this caller read `rel` in the vault bound at `root`
 * exactly as read_note could? It IS read_note's check, not a mirror of it: enforcePathAcl("read")
 * on the bound root, so an invalid or `..` path, the hard-denied roots, readPaths /
 * strictReadDefault, the path's rule-scopes, symlink resolution (the REAL path is what the ACL
 * sees) and the hard-link refusal all apply. A path that does not exist yet resolves through its
 * deepest existing ancestor, as it does for a write target. Anything that cannot be resolved FAILS
 * CLOSED. There is deliberately no "unrestricted caller" shortcut: only the readPaths glob is
 * cheap to skip, and enforcePathAcl already skips it when there is none.
 *
 * With no ACL at all enforcePathAcl does not stat for a hard link (the fd readers refuse it at
 * read time), so that one refusal is repeated here: read_note would refuse the file either way.
 */
export function callerCanReadVaultPath(
  acl: FolderAcl | undefined,
  grantedScopes: Iterable<string>,
  root: string,
  rel: string,
): boolean {
  try {
    enforcePathAcl(acl, "read", rel, root, grantedScopes);
    if (!acl) {
      const st = statSync(resolveVaultPathChecked(root, rel).abs, { throwIfNoEntry: false });
      if (st?.isFile() && st.nlink > 1) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * The guard every SECONDARY rewrite goes through: backlink and reference maintenance (move_note,
 * bulk_move_notes, move_attachment) repoints links in every note that links the moved target, outside
 * the caller's write whitelist, and that carve-out must never write an immutable path (a vault's raw
 * sources). `blocks(rel)` is asked once per note about to be rewritten: true means leave it alone. It
 * judges the name as written AND the real path, like enforcePathAcl, and fails closed when the path
 * cannot be resolved. `out()` is the report: the paths the caller may read, a bare count for the rest
 * (a path would disclose a note the caller cannot see), and a warning that those links now point at the
 * old name.
 */
export class ImmutableRewriteSkips {
  private readonly named = new Set<string>();
  private hidden = 0;

  constructor(
    private readonly acl: FolderAcl | undefined,
    private readonly root: string,
    private readonly grantedScopes: Iterable<string>,
  ) {}

  blocks(rel: string): boolean {
    if (!this.acl?.hasImmutablePaths) return false;
    let immutable: boolean;
    try {
      immutable =
        this.acl.immutableGlobFor(normalizeVaultPath(rel)) !== null ||
        this.acl.immutableGlobFor(resolveVaultPathChecked(this.root, rel).aclRel) !== null;
    } catch {
      immutable = true;
    }
    if (!immutable) return false;
    if (callerCanReadVaultPath(this.acl, this.grantedScopes, this.root, rel)) this.named.add(rel);
    else this.hidden++;
    return true;
  }

  out(): {
    immutable_not_updated?: string[];
    immutable_not_updated_hidden?: number;
    immutable_warning?: string;
  } {
    const total = this.named.size + this.hidden;
    if (total === 0) return {};
    return {
      ...(this.named.size > 0 ? { immutable_not_updated: [...this.named].sort() } : {}),
      ...(this.hidden > 0 ? { immutable_not_updated_hidden: this.hidden } : {}),
      immutable_warning: `${total} immutable (raw source) note${total === 1 ? "" : "s"} link${total === 1 ? "s" : ""} the moved target and ${total === 1 ? "was" : "were"} not rewritten: those links still point at the old name`,
    };
  }
}
