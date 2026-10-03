// Shared Zod primitives for the tool surface (G2.1 "Standard primitives").
// Reused across every vault-touching tool so path-safety and pagination are
// uniform. The traversal guard here is defense-in-depth; the filesystem
// resolver (packages/server/src/vault/paths.ts) re-checks real-path containment.
import { z } from "zod";

/** Vault registry id: lowercase slug. */
export const VaultId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_-]+$/, "vault id must be a lowercase slug");

/**
 * Vault-relative path. Rejects absolute paths (POSIX and Windows drive paths)
 * and any ".." segment. Backslashes are tolerated on input and normalized by
 * the resolver; the byte-level guard stays conservative per G2.1.
 */
export const VaultPath = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => !/(^|\/|\\)\.\.($|\/|\\)/.test(p), "path traversal rejected")
  .refine(
    (p) => !p.startsWith("/") && !p.startsWith("\\") && !/^[A-Za-z]:[\\/]/.test(p),
    "absolute paths rejected",
  );

/** Why a single path segment is unsafe on Windows (and so refused on EVERY platform when a write
 *  would create it: a vault syncs across operating systems). */
export type WindowsNameProblem = "reserved_name" | "colon" | "trailing_dot_or_space";

// CON/PRN/AUX/NUL/COM1-9/LPT1-9 with any extension; Win32 also ignores spaces between the device
// name and the extension ("NUL .txt").
const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]) *(?:\..*)?$/i;

/**
 * Classify one vault path segment against the Windows name rules, or null when it is fine.
 * `:` anywhere in a segment (on NTFS `report.md:.png` names the `.png` alternate data stream of
 * `report.md`), a trailing `.` or space (Win32 strips it, so `a.md.` aliases `a.md`), and the
 * reserved device names. `.`/`..`/empty segments are path syntax, not names, and are not judged.
 *
 * NOT part of {@link VaultPath}: that schema also guards READS, and a vault synced from Linux can
 * already hold such a name on this filesystem — refusing it there would make an existing note
 * unreadable. The server applies this to a write that would CREATE the name (see
 * `assertWritableVaultPath`).
 */
export function windowsNameProblem(segment: string): WindowsNameProblem | null {
  if (segment === "" || segment === "." || segment === "..") return null;
  if (segment.includes(":")) return "colon";
  if (segment.endsWith(".") || segment.endsWith(" ")) return "trailing_dot_or_space";
  if (WINDOWS_RESERVED.test(segment)) return "reserved_name";
  return null;
}

/**
 * The characters in one NAME (a single path segment) that cannot live inside a `[[wikilink]]`, as
 * the short labels an error message can show, or null when the name is link-safe. Obsidian's own
 * link rule (help.obsidian.md "Internal links"): a name with `# | ^ : %% [[ ]]` "may not work as a
 * link"; `:` is already refused by {@link windowsNameProblem}. A newline or any other control
 * character is added because a link body is one line, and the rewrite splices the name into it.
 *
 * Such a name closes the link early (`]]`), starts an alias (`|`), a heading (`#`) or a block
 * reference (`^`), opens a comment (`%%`), or breaks out of the line, so renaming a note TO it makes
 * the backlink rewrite write the rest into every note that links the old name.
 *
 * NOT part of {@link VaultPath}, for the reason {@link windowsNameProblem} is not: reading or
 * linking an EXISTING file with such a name must keep working. The server applies this to a write
 * that would CREATE the name (see `assertCreatableName`).
 */
export function wikiLinkNameProblem(segment: string): string[] | null {
  const found = new Set<string>();
  for (const ch of segment) {
    if ("[]#^|".includes(ch)) found.add(ch);
    else if (ch === "\n" || ch === "\r") found.add("newline");
    else if (ch <= "\u001f" || ch === "\u007f") found.add("control character");
  }
  if (segment.includes("%%")) found.add("%%");
  return found.size === 0 ? null : [...found];
}

/** 32-char hex HITL elicit token (matches issueElicitToken: randomBytes(16).hex). */
export const ElicitToken = z.string().regex(/^[a-f0-9]{32}$/, "malformed elicit token");

/** Cursor pagination inputs (G2.1 convention). */
export const Pagination = z.object({
  limit: z.number().int().positive().max(1000).optional(),
  cursor: z.string().optional(),
});
/** Shared write options. `idempotency_key` is accepted as a forward-compat
 *  surface in M1 (replay lands with the Policy layer in a later milestone). */
export const WriteOptions = z.object({
  idempotency_key: z.string().min(1).max(128).optional(),
  create_dirs: z.boolean().default(true),
});
