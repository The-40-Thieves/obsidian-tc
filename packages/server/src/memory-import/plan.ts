// THE-1124 — build a ParsedSource (entities + skipped-with-reason) from an import directory,
// dispatching to the right adapter parser per file. Pure/offline: no vault, no dispatch, no
// filesystem writes — apply.ts turns this into vault mutations.
import { basename } from "node:path";
import { parseBasicMemoryFile } from "./basic-memory";
import { parseClaudeCodeMemoryFile } from "./claude-code-memory";
import type { ImportAdapterName, ParsedSource } from "./types";
import { walkImportDir } from "./walk";

const INDEX_FILE_NAME = "memory.md";

export function buildParsedSource(root: string, adapter: ImportAdapterName): ParsedSource {
  const { files, skipped } = walkImportDir(root, { extensions: [".md"] });
  const out: ParsedSource = { entities: [], skipped: [...skipped] };
  for (const f of files) {
    if (
      adapter === "claude-code-memory" &&
      basename(f.sourcePath).toLowerCase() === INDEX_FILE_NAME
    ) {
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
  out.skipped.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
  return out;
}
