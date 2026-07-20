// docgen — errors extractor (THE-471). The ObsidianTcError taxonomy is a TypeScript union (not
// enumerable at runtime), but the `err` factory map is: each entry builds an ObsidianTcError whose
// `.code` is the canonical code and whose default `.message` is the human fallback. Call each with no
// args to read both. Deduped by code (a few factories share a code).
import { err } from "@the-40-thieves/obsidian-tc-shared";
import type { ErrorDoc } from "./model";

type ErrFactory = () => { code: string; message: string };

export function extractErrors(): ErrorDoc[] {
  const seen = new Set<string>();
  const out: ErrorDoc[] = [];
  for (const factory of Object.values(err as Record<string, unknown>)) {
    if (typeof factory !== "function") continue;
    const e = (factory as ErrFactory)();
    if (seen.has(e.code)) continue;
    seen.add(e.code);
    out.push({ code: e.code, description: e.message });
  }
  out.sort((a, b) => a.code.localeCompare(b.code));
  return out;
}
