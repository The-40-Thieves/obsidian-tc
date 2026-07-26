// THE-577 established this gate because the facade domain map (mcp/facade.ts DOMAINS) was a
// hand-maintained parallel catalog of the tool surface, and nothing enforced that it tracked the
// registry. It fell 38 tools behind — 146 registered, 108 mapped — and stayed silent, because
// domainTools() swept anything unmapped into an "other" bucket.
//
// THE-513 deleted that map: each tool now declares its own `domain` on its ToolDefinition, so the
// forgot-to-add-it failure mode is a compile error, not a silent gap. This gate now closes what a
// type error alone cannot:
//   forward  — a registered tool whose `domain` is not one of the 13 known ids (a typo that still
//              type-checks against a widened type, or a definition built outside defineTool's
//              compile-time check).
//   backward — a known domain id with zero members (a domain that lost its last tool, or a rename
//              nobody re-pointed), which would otherwise ship as a dead "action" enum of nothing.
//
// Registry assembly reuses buildFullRegistry() (scripts/docgen/build-registry.ts) rather than
// re-assembling the M1-M8 registration recipe by hand — see output-schema-coverage.test.ts, which
// found that recipe copied a third time with only one copy read by the version-coherence gate.
import { describe, expect, it } from "vitest";
import { buildFullRegistry } from "../scripts/docgen/build-registry";
import { TOOL_DOMAINS } from "../src/mcp/registry";
import { REGISTERED_TOOL_COUNT } from "./registered-tool-count";

describe("THE-577/THE-513 facade domain coverage", () => {
  it("maps every registered tool to a known domain, and leaves no known domain empty", () => {
    const registered = buildFullRegistry().list();

    // Sanity floor: an empty or truncated registry would make both assertions below pass
    // vacuously. See feedback on green checks that cover nothing.
    expect(registered.length).toBe(REGISTERED_TOOL_COUNT);

    const known = new Set<string>(TOOL_DOMAINS);

    // Forward: every registered tool must declare one of the known domain ids.
    const unmapped = registered
      .filter((t) => !t.domain || !known.has(t.domain))
      .map((t) => `${t.name} (domain: ${String(t.domain)})`)
      .sort();
    expect(
      unmapped,
      `${unmapped.length} registered tool(s) have no/unknown facade domain — declare "domain" as ` +
        `one of ${[...known].join(", ")} on the tool's defineTool spec: ${unmapped.join(", ")}`,
    ).toEqual([]);

    // Backward: every known domain id must have at least one member, or it is a dead entry.
    const counts = new Map<string, number>();
    for (const t of registered) if (t.domain) counts.set(t.domain, (counts.get(t.domain) ?? 0) + 1);
    const empty = TOOL_DOMAINS.filter((d) => !counts.get(d)).sort();
    expect(empty, `${empty.length} domain id(s) have zero members: ${empty.join(", ")}`).toEqual(
      [],
    );
  });
});
