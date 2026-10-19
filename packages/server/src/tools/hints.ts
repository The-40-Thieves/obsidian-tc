// The advisory `hint` channel on tool outputs: an optional field beside a tool's primary result
// (`matches`, `items`, ...), never inside it. Every hint carries a `reason` and a `message`; a
// reason adds its own fields. A new reason gets its builder here, not an inline object in a tool.

import { z } from "zod";
import { editDistance } from "../mcp/registry/input-binding";

export const ToolHint = z.looseObject({ reason: z.string(), message: z.string() });
export type ToolHint = z.infer<typeof ToolHint>;

export type UnknownPropertyHint = ToolHint & {
  reason: "unknown_property";
  suggestions: string[];
};

/** Distinct top-level keys a scan may collect for suggestions. A vault with more distinct keys than
 *  this still gets suggestions, drawn from the first ones the scan met. */
export const KNOWN_KEY_LIMIT = 200;
const SUGGESTION_LIMIT = 5;
const SUGGESTION_MAX_DISTANCE = 2;

/** Adds one note's top-level keys to `pool`, stopping at `KNOWN_KEY_LIMIT` distinct keys. */
export function noteKeys(pool: Set<string>, frontmatter: Record<string, unknown>): void {
  for (const key of Object.keys(frontmatter)) {
    if (pool.size >= KNOWN_KEY_LIMIT) return;
    pool.add(key);
  }
}

/** The hint for a property lookup that matched nothing because no readable note has the key. For a
 *  nested key only the first segment is matched, against top-level keys, and the message says so. */
export function unknownPropertyHint(
  key: string,
  knownKeys: Iterable<string>,
  nested: boolean,
): UnknownPropertyHint {
  const segment = nested ? (key.split(".")[0] ?? key) : key;
  const suggestions = rankSimilarKeys(segment, knownKeys);
  const scope = nested
    ? " Only the first segment of a nested key is matched, against top-level keys."
    : "";
  const quoted = suggestions.map((s) => `"${s}"`).join(", ");
  const message =
    suggestions.length > 0
      ? `no readable note has the property "${key}"; did you mean ${quoted}?${scope}`
      : `no readable note has the property "${key}".${scope}`;
  return { reason: "unknown_property", message, suggestions };
}

/** Case-insensitive exact match first, then singular/plural, then edit distance within
 *  `SUGGESTION_MAX_DISTANCE`; ties break on distance, then name. */
function rankSimilarKeys(key: string, knownKeys: Iterable<string>): string[] {
  const wanted = key.toLowerCase();
  const ranked: Array<{ name: string; tier: number; distance: number }> = [];
  for (const name of knownKeys) {
    const lower = name.toLowerCase();
    const distance = editDistance(wanted, lower);
    const tier = lower === wanted ? 0 : lower === `${wanted}s` || wanted === `${lower}s` ? 1 : 2;
    if (tier === 2 && distance > SUGGESTION_MAX_DISTANCE) continue;
    ranked.push({ name, tier, distance });
  }
  ranked.sort((a, b) => a.tier - b.tier || a.distance - b.distance || a.name.localeCompare(b.name));
  return ranked.slice(0, SUGGESTION_LIMIT).map((r) => r.name);
}
