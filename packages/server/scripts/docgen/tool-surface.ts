// What a client is actually shown: every tool the server can advertise, per surface, built with the
// SAME projection functions tools/list uses (mcp/server.ts), so the name and description gates read
// the wire shape rather than a parallel copy of it.
//
// Surfaces:
//   flat            every registered tool (the `flat` facade mode, and `/mcp/flat`)
//   triad           find/describe/call_capability + the standard `search`/`fetch` direct pair
//   triad-no-vault  the same triad on a server with no vault registry (find_capability's text differs)
//   domain          one meta-tool per domain, its description listing every member action
//   essentials/core flat subsets (`toolFacade.advertise`): the SAME projected tools, filtered. They
//                   add names to check but no description of their own.
//
// Pure over a registry so test/tool-name-hygiene.test.ts and test/tool-description-snapshot.test.ts
// share one definition of "advertised", and `bun scripts/tool-descriptions.ts --update` rewrites the
// committed snapshot from the same function the test compares against.
import type { Tool } from "@modelcontextprotocol/server";
import { domainTools, triadDirectTools, triadTools } from "../../src/mcp/facade";
import type { ToolRegistry } from "../../src/mcp/registry";
import { isAdvertisedIn } from "../../src/mcp/tool-profiles";
import { toMcpTool } from "../../src/mcp/tool-projection";

// A type alias, not an interface: only an alias is assignable to the string-indexed shape
// `Object.values` needs to keep its element type.
export type AdvertisedSurfaces = {
  flat: Tool[];
  triad: Tool[];
  "triad-no-vault": Tool[];
  domain: Tool[];
  essentials: Tool[];
  core: Tool[];
};

/** Surfaces whose descriptions are text of their own. essentials/core re-advertise `flat` verbatim. */
export const SNAPSHOT_SURFACES = ["flat", "triad", "triad-no-vault", "domain"] as const;

export function advertisedSurfaces(registry: ToolRegistry): AdvertisedSurfaces {
  const defs = registry.list();
  const flat = defs.map(toMcpTool);
  const direct = (hasResources: boolean): Tool[] => [
    ...triadTools(hasResources),
    ...triadDirectTools(defs, toMcpTool),
  ];
  return {
    flat,
    triad: direct(true),
    "triad-no-vault": direct(false),
    domain: domainTools(defs),
    essentials: defs.filter((d) => isAdvertisedIn("essentials", d.name)).map(toMcpTool),
    core: defs.filter((d) => isAdvertisedIn("core", d.name)).map(toMcpTool),
  };
}

/**
 * The surfaces the name gate compares. `triad-no-vault` is the triad's own text variant (same three
 * names, find_capability's description differs), never advertised beside it, so it is left out of
 * the cross-surface identity rule rather than allowlisted as a collision with itself.
 */
export function nameCheckSurfaces(surfaces: AdvertisedSurfaces): Record<string, readonly Tool[]> {
  const { "triad-no-vault": _variant, ...rest } = surfaces;
  return rest;
}

/** `<surface>/<tool>` -> the description a client hashes. */
export function descriptionEntries(surfaces: AdvertisedSurfaces): Record<string, string> {
  const out: Record<string, string> = {};
  for (const surface of SNAPSHOT_SURFACES) {
    for (const tool of surfaces[surface]) out[`${surface}/${tool.name}`] = tool.description ?? "";
  }
  return out;
}

/**
 * The committed snapshot's exact bytes: keys sorted by code unit (not locale, so every OS agrees),
 * one entry per line. A description change is therefore a one-line diff, and two PRs that touch
 * different tools never touch the same line.
 */
export function renderDescriptionSnapshot(entries: Record<string, string>): string {
  const keys = Object.keys(entries).sort();
  const rows = keys.map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(entries[k])}`);
  return `{\n${rows.join(",\n")}\n}\n`;
}
