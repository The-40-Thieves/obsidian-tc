// THE-629: `derived.liveness` asserted "no writer exists" for a table that has two writers and five
// registered tools reaching them.
//
// The ticket's title says the empty tables are "downstream of a missing writer". That premise was
// never verified, and it propagated into the health surface as a classification: doctor listed
// `memory_entities` / `memory_relations` as `writer: "none"` with the lever "no writer exists".
//
// Both halves of that are wrong. `memory/entities.ts:97` (`insertEntity`) and `:164`
// (`insertRelation`) are the writers, and `tools/m5/memory-tools.ts` registers create_entity,
// get_entity, add_observation, link_entities and query_entity_graph over them. The tables are empty
// because nothing has CALLED the surface — which is what `on-demand` means, and which is exactly
// how `workspace_sessions` two lines below was already classified.
//
// The distinction has teeth. `checks.ts` filters `rows === 0 && writer === "on-demand"` and reports
// those WITHOUT warning ("a feature awaiting its first use"); `none` stays a finding. So doctor was
// warning about a missing writer that is not missing, and directing anyone who investigated toward
// building one that already exists.
//
// This asserts the classification against the CODE rather than against a copy of it, so the two
// cannot drift apart again — which is how the wrong classification survived in the first place.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const doctor = read("../src/cli/commands/doctor.ts");
const entities = read("../src/memory/entities.ts");
const memoryTools = read("../src/tools/m5/memory-tools.ts");

describe("THE-629: the entity tables have a writer, and doctor must not claim otherwise", () => {
  it("the writers actually exist — the premise this classification rested on is false", () => {
    // Asserted first, because everything below is only correct if this is.
    expect(entities).toContain("INSERT INTO memory_entities");
    expect(entities).toContain("INSERT INTO memory_relations");
  });

  it("five registered tools reach those writers", () => {
    for (const tool of [
      "create_entity",
      "get_entity",
      "add_observation",
      "link_entities",
      "query_entity_graph",
    ])
      expect(memoryTools).toContain(`name: "${tool}"`);
  });

  it("doctor classifies both tables as on-demand, not none", () => {
    expect(doctor).toContain('["memory_entities", "on-demand"');
    expect(doctor).toContain('["memory_relations", "on-demand"');
  });

  it('doctor no longer claims "no writer exists"', () => {
    // The specific false sentence. Named literally so a revert is caught by the assertion that
    // describes it, not by an incidental one.
    expect(doctor).not.toContain("no writer exists");
  });

  it("the lever names the tool a caller would actually invoke", () => {
    // A lever saying "no writer exists" sends an investigator to build a writer. The lever's whole
    // job is to say what would make the table non-empty, and here that is calling a tool.
    expect(doctor).toContain("a client calling create_entity");
    expect(doctor).toContain("a client calling link_entities");
  });
});

describe("THE-726 follow-on: the workspace_sessions lever is no longer client-only", () => {
  it("names the server as a writer too, since sessions.autoOpen opens them", () => {
    // The table stopped being empty on 2026-08-04 without any client change. A lever that still
    // said "a client calling the start_session tool" would send an investigator looking for a
    // client that does not exist and never will.
    expect(doctor).toContain("or the server itself under sessions.autoOpen");
  });

  it("stays on-demand — autoOpen is off by default and nothing writes it unasked", () => {
    expect(doctor).toContain('"workspace_sessions",\n          "on-demand",');
  });
});
