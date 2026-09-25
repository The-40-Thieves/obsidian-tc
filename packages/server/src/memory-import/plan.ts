// THE-1124 — build a ParsedSource (entities + skipped-with-reason) from an import directory,
// dispatching to the right adapter parser per file. Pure/offline: no vault, no dispatch, no
// filesystem writes — apply.ts turns this into vault mutations.
import { readdirSync } from "node:fs";
import { entityNotePath } from "../memory/materialize";
import { parseBasicMemoryFile } from "./basic-memory";
import { parseClaudeCodeMemoryFile } from "./claude-code-memory";
import type { ImportAdapterName, ParsedEntity, ParsedSource } from "./types";
import { walkImportDir } from "./walk";

// Exact case, at the import ROOT only — review finding: matching by basename() at any depth (or
// case-insensitively) could skip a REAL fact file a subfolder happens to name the same, or one
// named "memory.md"/"Memory.md" deliberately (an unusual but legal frontmatter/name combination).
// A Claude Code memory index is always exactly `MEMORY.md` at the checkout root.
const INDEX_FILE_NAME = "MEMORY.md";

/**
 * Review finding (CI, macOS/Windows): on a case-INSENSITIVE filesystem, "MEMORY.md" and
 * "memory.md" at the same directory are not two files — they are the SAME directory entry, and
 * whichever write happened last decided its CONTENT while the filesystem decides (platform-
 * specific, not this code's business) what NAME survives in the listing. Comparing a walked
 * file's path against the literal string "MEMORY.md" is already correct AS LONG AS that string
 * came from the real, on-disk directory listing rather than being asserted independently of it —
 * which is exactly what this does: resolve the root's ACTUAL entries once, and only an entry that
 * is really spelled "MEMORY.md" there is the index. On a case-sensitive filesystem this can never
 * differ from a direct string check (two distinctly-cased files coexist, and only the exact-case
 * one matches). On a case-insensitive one, it means: whatever the filesystem reports as the root's
 * "MEMORY.md"-spelled entry (if any) is unconditionally the index, even though a caller "meant" to
 * write a lowercase `memory.md` fact file there — the OS made that the same file, so there is no
 * behavior this code could choose that recovers a second, independent one. Never trust
 * `walkImportDir`'s already-filtered/sorted output for this alone; re-read the root directly.
 */
function rootIndexEntryName(root: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return null;
  }
  return entries.find((name) => name === INDEX_FILE_NAME) ?? null;
}

/** A constant placeholder folder — entityNotePath's OWN sanitizeSegment logic is what matters for
 *  collision detection, not the folder prefix every candidate shares regardless of which real
 *  memory folder the vault configures. Reusing entityNotePath (not re-deriving the sanitize rule)
 *  guarantees this key agrees with the ACTUAL write path apply.ts's create_entity will use. */
const COLLISION_ROOT = "_";

function collisionKey(e: Pick<ParsedEntity, "entityType" | "name">): string {
  return entityNotePath(COLLISION_ROOT, e.entityType, e.name);
}

export function buildParsedSource(root: string, adapter: ImportAdapterName): ParsedSource {
  const { files, skipped } = walkImportDir(root, { extensions: [".md"] });
  const indexEntryName = adapter === "claude-code-memory" ? rootIndexEntryName(root) : null;
  const out: ParsedSource = { entities: [], skipped: [...skipped] };
  for (const f of files) {
    if (indexEntryName !== null && f.sourcePath === indexEntryName) {
      out.skipped.push({ sourcePath: f.sourcePath, reason: "index file (not imported)" });
      continue;
    }
    const result =
      adapter === "basic-memory"
        ? parseBasicMemoryFile(f.raw, f.sourcePath)
        : parseClaudeCodeMemoryFile(f.raw, f.sourcePath);
    if (!result.ok) {
      out.skipped.push({ sourcePath: f.sourcePath, reason: result.reason });
      continue;
    }
    out.entities.push(result.entity);
  }

  // Review finding: two files whose (type, name) sanitize to the SAME memory-note path — an
  // outright duplicate title, or two different (type, name) pairs `entityNotePath`'s
  // sanitizeSegment happens to collapse to the same segment (e.g. "A:B" and "A-B" both become
  // "A-B") — must show as a collision in the DRY-RUN preview, not only surface once apply.ts
  // tries to create the second one and gets an "already exists" from create_entity. Deterministic
  // winner: the first entity in this array (== first by source_path, since `files` above is
  // walkImportDir's sorted order) proceeds; every later one is moved to `skipped`.
  const seen = new Map<string, ParsedEntity>();
  const kept: ParsedEntity[] = [];
  for (const e of out.entities) {
    const key = collisionKey(e);
    const winner = seen.get(key);
    if (!winner) {
      seen.set(key, e);
      kept.push(e);
      continue;
    }
    out.skipped.push({
      sourcePath: e.sourcePath,
      reason:
        `collides with ${winner.sourcePath} at the same memory-note path ` +
        `(${e.entityType}/${e.name} vs ${winner.entityType}/${winner.name}); ` +
        `keeping ${winner.sourcePath} (first by source_path)`,
    });
  }
  out.entities = kept;

  out.skipped.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
  return out;
}
