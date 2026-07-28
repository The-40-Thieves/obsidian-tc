// docgen — errors extractor (THE-471). The ObsidianTcError taxonomy is a TypeScript union (not
// enumerable at runtime), but the `err` factory map is: each entry builds an ObsidianTcError whose
// `.code` is the canonical code and whose default `.message` is the human fallback. Call each with no
// args to read both. Deduped by code (a few factories share a code).
import { type ErrorCode, err, recoveryFor } from "@the-40-thieves/obsidian-tc-shared";
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
    // THE-470: the recovery hint (THE-512) is pulled from the same taxonomy rather than
    // re-described here. `RECOVERY` is `Record<ErrorCode, string | null>`, so it is exhaustive by
    // construction — a new code cannot ship without declaring a hint or an explicit `null`, and
    // `recoveryFor` maps that `null` to undefined. Nothing to keep in sync by hand.
    out.push({
      code: e.code,
      description: e.message,
      recovery: recoveryFor(e.code as ErrorCode),
    });
  }
  out.sort((a, b) => a.code.localeCompare(b.code));
  return out;
}
