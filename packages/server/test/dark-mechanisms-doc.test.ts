// docs/DARK_MECHANISMS.md is an inventory, and an inventory drifts. This keeps it honest in both
// directions against the generated config schema: every default-off retrieval flag has a row, and
// every config key the doc names still exists.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const schema = JSON.parse(readFileSync(join(ROOT, "docs/obsidian-tc.config.schema.json"), "utf8"));
const doc = readFileSync(join(ROOT, "docs/DARK_MECHANISMS.md"), "utf8");

interface Leaf {
  type?: string;
  default?: unknown;
}

/** Every leaf of the schema keyed by dotted path; an object with `properties` is not a leaf. */
function leaves(node: unknown, path: string[], out: Map<string, Leaf>): Map<string, Leaf> {
  const n = node as { properties?: Record<string, unknown> } & Leaf;
  if (n.properties) {
    for (const [k, v] of Object.entries(n.properties)) leaves(v, [...path, k], out);
  } else if (path.length > 0) {
    out.set(path.join("."), n);
  }
  return out;
}

const all = leaves(schema, [], new Map());

/** Dark flags outside `retrieval.*` that the inventory also covers, named because their defaults are
 *  not a plain `false` (a string preset, an enum) or because the flag lives in another block. */
const EXTRA_DARK_KEYS = [
  "ranking.metadataPrior.enabled",
  "experiential.activationRerank",
  "reranker.passageFormat",
  "retrieval.searchAutoRoute",
];

const defaultOffRetrieval = [...all.entries()]
  .filter(([k, v]) => k.startsWith("retrieval.") && v.type === "boolean" && v.default === false)
  .map(([k]) => k);

const documented = new Set(
  [...doc.matchAll(/`((?:retrieval|ranking|experiential|reranker)\.[A-Za-z.]+)`/g)].map(
    (m) => m[1] as string,
  ),
);

describe("DARK_MECHANISMS.md inventory", () => {
  it("has a floor: the schema walk found the flags it is meant to cover", () => {
    expect(defaultOffRetrieval.length).toBeGreaterThanOrEqual(12);
    for (const k of EXTRA_DARK_KEYS) expect(all.has(k), `${k} left the schema`).toBe(true);
  });

  it("names every default-off retrieval flag in the config schema", () => {
    const missing = [...defaultOffRetrieval, ...EXTRA_DARK_KEYS].filter((k) => !documented.has(k));
    expect(missing, `add a row to docs/DARK_MECHANISMS.md for: ${missing.join(", ")}`).toEqual([]);
  });

  it("names no config key the schema no longer has", () => {
    const prefixes = new Set(
      [...all.keys()].flatMap((k) => k.split(".").map((_, i, a) => a.slice(0, i + 1).join("."))),
    );
    const stale = [...documented].filter((k) => !all.has(k) && !prefixes.has(k));
    expect(stale, `stale keys in docs/DARK_MECHANISMS.md: ${stale.join(", ")}`).toEqual([]);
  });

  it("documents a non-trivial number of keys", () => {
    expect(documented.size).toBeGreaterThanOrEqual(12);
  });
});
