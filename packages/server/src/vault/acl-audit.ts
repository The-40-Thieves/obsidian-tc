// THE-414 follow-up (issue #280): an opt-in, dev/test-only audit that verifies a tool's declared
// `pathAcl` extractor actually MIRRORS the vault paths its handler resolves for filesystem ops.
//
// `acl-extraction-coverage.test.ts` proves every mutating path tool DECLARES a pathAcl (or is a
// documented exemption). This catches the next bug class: a declared extractor that returns the
// WRONG or INCOMPLETE set — so the central dispatch stage checks path A while the handler actually
// touches path B. Enabled only when OBSIDIAN_TC_ACL_AUDIT is set (never in production):
//   - "on" / "1": collect violations (read them via getCollectedViolations()).
//   - "strict":   additionally throw the moment an uncovered fs-op path is resolved.
//
// Mechanism: runDispatch wraps the central pathAcl stage + the handler in an AsyncLocalStorage
// frame. enforcePathAcl records each path it checks; resolveVaultPath (the sole fs-op path wrapper)
// reports each path a handler resolves. A path resolved for an fs op but never ACL-checked in the
// same dispatch is a violation. The central stage records BEFORE the handler runs, so ordering
// inside the handler does not matter. Every entry point is a no-op when disabled, so production
// carries zero overhead beyond one boolean check.
import { AsyncLocalStorage } from "node:async_hooks";

export interface AclAuditViolation {
  tool: string;
  /** aclRel resolved for a filesystem op that no folder-ACL check covered in this dispatch. */
  path: string;
}

interface AuditFrame {
  tool: string;
  /** When false, uncovered fs-op path uses are not flagged: for tools that intentionally touch
   *  dynamic paths beyond their static pathAcl (cross-note backlink / reference rewrites). */
  auditUses: boolean;
  checked: Set<string>;
}

/** Tools that declare a pathAcl for their primary paths but intentionally resolve ADDITIONAL,
 *  runtime-discovered paths — rewriting links / references in other notes. Those extra fs-op path
 *  uses are a documented carve-out (THE-303 / N-3), so use-flagging is skipped for them (their
 *  declared from/to paths are still centrally enforced). */
export const CROSS_NOTE_REWRITE_TOOLS = new Set<string>([
  "move_note", // updateBacklinks() rewrites every note linking the moved one
  "move_attachment", // rewriteAttachmentReferences() rewrites linking notes (integrity carve-out)
  "bulk_move_notes", // per-row moves + the all-or-nothing backlink rewrite phase
]);

let _enabled = false;
let _strict = false;
let _collected: AclAuditViolation[] = [];

function applyMode(mode: string): void {
  _enabled = mode === "1" || mode === "on" || mode === "strict";
  _strict = mode === "strict";
}
applyMode(process.env.OBSIDIAN_TC_ACL_AUDIT ?? "");

/** Test-only: force the audit mode at runtime (production reads OBSIDIAN_TC_ACL_AUDIT once at load). */
export function setAclAuditMode(mode: "off" | "on" | "strict"): void {
  applyMode(mode === "off" ? "" : mode);
}

export function aclAuditEnabled(): boolean {
  return _enabled;
}

const als = new AsyncLocalStorage<AuditFrame>();

/** Run `fn` inside a fresh audit frame. A transparent passthrough when the audit is disabled. */
export function runAudited<T>(opts: { tool: string; auditUses: boolean }, fn: () => T): T {
  if (!_enabled) return fn();
  return als.run({ tool: opts.tool, auditUses: opts.auditUses, checked: new Set() }, fn);
}

/** Record that `aclRel` passed a folder-ACL check (called from enforcePathAcl on success). */
export function recordAclCheck(aclRel: string): void {
  if (!_enabled) return;
  als.getStore()?.checked.add(aclRel);
}

/** Record that `aclRel` was resolved for a filesystem op (called from resolveVaultPath). Flags a
 *  violation when the current tool audits uses and no ACL check covered this path; throws in strict
 *  mode so the offending call fails loudly. */
export function recordPathUse(aclRel: string): void {
  if (!_enabled) return;
  const frame = als.getStore();
  if (!frame?.auditUses) return;
  if (frame.checked.has(aclRel)) return;
  _collected.push({ tool: frame.tool, path: aclRel });
  if (_strict)
    throw new Error(
      `ACL audit: ${frame.tool} resolved "${aclRel}" for a filesystem op with no folder-ACL check`,
    );
}

/** Violations collected since the last clear (dev/test only). */
export function getCollectedViolations(): readonly AclAuditViolation[] {
  return _collected;
}

export function clearCollectedViolations(): void {
  _collected = [];
}
