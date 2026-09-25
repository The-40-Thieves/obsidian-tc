// THE-1130 adversarial-review verification — keyed-interval behavioral semantics: case-folded key
// matching scoped to the SAME entity, identical-text supersession, unkeyed rows staying open,
// retirement refusal when there is nothing open to retire, get_entity/query_entity_graph agreeing
// exactly on the as_of half-open boundary, note-rendering byte shape for the open/no-Superseded
// case, `assertNoteOwnership`'s foreign-note refusal, and the MCP output schemas validating real
// payloads under ajv (not just zod's safeParse, which silently strips an undeclared field).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { describe, expect, it } from "vitest";
import { toJson } from "../src/mcp/facade";
import { assertNoteOwnership, renderEntityNote } from "../src/memory/materialize";
import { makeM5Vault } from "./m5-helpers";

interface Obs {
  text: string;
  key: string | null;
  valid_from: number;
  valid_to: number | null;
  superseded_by: string | null;
}

async function create(v: ReturnType<typeof makeM5Vault>, name: string): Promise<string> {
  const result = await v.call(
    "create_entity",
    { vault: "test", type: "probe", name, materialize: false },
    { now: () => 100 },
  );
  if (!result.ok) throw new Error(`create failed: ${JSON.stringify(result.error)}`);
  return (result.data as { entity_id: string }).entity_id;
}

async function observations(
  v: ReturnType<typeof makeM5Vault>,
  id: string,
  asOf: number,
): Promise<Obs[]> {
  const result = await v.call("get_entity", { vault: "test", entity_id: id, as_of: asOf });
  if (!result.ok) throw new Error(`get failed: ${JSON.stringify(result.error)}`);
  return (result.data as { observations: Obs[] }).observations;
}

describe("THE-1130 keyed interval semantics", () => {
  it("normalizes key case, closes only the same entity/key, handles identical text, and leaves unkeyed rows open", async () => {
    const v = makeM5Vault();
    try {
      const a = await create(v, "A");
      const b = await create(v, "B");
      await v.call(
        "add_observation",
        { vault: "test", entity_id: a, observation: "same", key: "Employer" },
        { now: () => 200 },
      );
      await v.call(
        "add_observation",
        { vault: "test", entity_id: a, observation: "unkeyed" },
        { now: () => 210 },
      );
      await v.call(
        "add_observation",
        { vault: "test", entity_id: b, observation: "other entity", key: "employer" },
        { now: () => 220 },
      );
      const repeated = await v.call(
        "add_observation",
        { vault: "test", entity_id: a, observation: "same", key: "EMPLOYER" },
        { now: () => 300 },
      );
      expect(repeated.ok).toBe(true);

      expect(await observations(v, a, 299)).toEqual([
        {
          text: "same",
          key: "employer",
          valid_from: 200,
          valid_to: 300,
          superseded_by: expect.any(String),
        },
        { text: "unkeyed", key: null, valid_from: 210, valid_to: null, superseded_by: null },
      ]);
      expect(await observations(v, a, 300)).toEqual([
        { text: "unkeyed", key: null, valid_from: 210, valid_to: null, superseded_by: null },
        { text: "same", key: "employer", valid_from: 300, valid_to: null, superseded_by: null },
      ]);
      expect((await observations(v, b, 300)).map((o) => o.text)).toEqual(["other entity"]);
    } finally {
      v.cleanup();
    }
  });

  it("refuses retirement when that entity has no open observation for the key", async () => {
    const v = makeM5Vault();
    try {
      const a = await create(v, "A");
      const b = await create(v, "B");
      await v.call(
        "add_observation",
        { vault: "test", entity_id: b, observation: "exists elsewhere", key: "employer" },
        { now: () => 200 },
      );
      const retired = await v.call("add_observation", {
        vault: "test",
        entity_id: a,
        key: "employer",
        valid_to: new Date(300).toISOString(),
      });
      expect(retired.ok).toBe(false);
      if (!retired.ok) {
        expect(retired.error.code).toBe("invalid_input");
        expect(retired.error.message).toMatch(/no open observation/i);
      }
    } finally {
      v.cleanup();
    }
  });
});

describe("THE-1130 as_of agreement and boundaries", () => {
  it("get_entity and query_entity_graph return the same exact half-open set", async () => {
    const v = makeM5Vault();
    try {
      const seed = await create(v, "seed");
      const target = await create(v, "target");
      await v.call("link_entities", {
        vault: "test",
        source_id: seed,
        target_id: target,
        relation_type: "knows",
      });
      await v.call(
        "add_observation",
        {
          vault: "test",
          entity_id: target,
          observation: "bounded",
          valid_from: new Date(200).toISOString(),
          valid_to: new Date(300).toISOString(),
        },
        { now: () => 150 },
      );
      await v.call(
        "add_observation",
        {
          vault: "test",
          entity_id: target,
          observation: "open later",
          valid_from: new Date(300).toISOString(),
        },
        { now: () => 150 },
      );

      for (const [asOf, expected] of [
        [199, []],
        [200, ["bounded"]],
        [299, ["bounded"]],
        [300, ["open later"]],
      ] as const) {
        const direct = await observations(v, target, asOf);
        const graph = await v.call("query_entity_graph", {
          vault: "test",
          seed_entity_id: seed,
          as_of: asOf,
        });
        if (!graph.ok) throw new Error(`graph failed: ${JSON.stringify(graph.error)}`);
        const graphObs = (
          graph.data as { items: Array<{ entity_id: string; observations: Obs[] }> }
        ).items.find((item) => item.entity_id === target)?.observations;
        expect(direct.map((o) => o.text)).toEqual(expected);
        expect(graphObs).toEqual(direct);
      }
    } finally {
      v.cleanup();
    }
  });
});

describe("THE-1130 note rendering and ownership", () => {
  it("keeps the pre-change bytes for open unkeyed observations and adds Superseded only for closed rows", () => {
    const base = {
      id: "ent_1",
      entityType: "person",
      name: "Ada",
      status: "active",
      relations: [{ relationType: "knows", targetName: "Babbage" }],
    } as const;
    const open = renderEntityNote({
      ...base,
      observations: [
        { text: "mathematician", key: null, validFrom: 100, validTo: null, supersededBy: null },
      ],
    });
    expect(open).toBe(
      "---\nobsidian_tc_id: ent_1\nentity_type: person\nstatus: active\n---\n# Ada\n\n## Observations\n\n- mathematician\n\n## Related\n\n- knows [[Babbage]]\n",
    );
    expect(open).not.toContain("## Superseded");
    const closed = renderEntityNote({
      ...base,
      observations: [
        { text: "mathematician", key: null, validFrom: 100, validTo: 200, supersededBy: null },
      ],
    });
    expect(closed).toContain("## Superseded");
  });

  it("assertNoteOwnership refuses a foreign note", () => {
    const v = makeM5Vault();
    try {
      const rel = "memory/person/Ada.md";
      const abs = join(v.root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      const original = "---\nobsidian_tc_id: foreign\n---\nDo not overwrite me.\n";
      writeFileSync(abs, original, "utf8");
      expect(() => assertNoteOwnership(v.root, rel, "ent_expected")).toThrow(
        /refusing to touch a note/i,
      );
      expect(readFileSync(abs, "utf8")).toBe(original);
    } finally {
      v.cleanup();
    }
  });
});

describe("THE-1130 MCP output schemas", () => {
  it("declare every observation field and AJV-validates real get and graph calls", async () => {
    const v = makeM5Vault();
    try {
      const seed = await create(v, "seed");
      const target = await create(v, "target");
      await v.call("link_entities", {
        vault: "test",
        source_id: seed,
        target_id: target,
        relation_type: "knows",
      });
      await v.call(
        "add_observation",
        { vault: "test", entity_id: target, observation: "fact", key: "kind" },
        { now: () => 200 },
      );
      const calls = [
        ["get_entity", { vault: "test", entity_id: target, as_of: 200 }],
        ["query_entity_graph", { vault: "test", seed_entity_id: seed, as_of: 200 }],
      ] as const;
      for (const [name, input] of calls) {
        const result = await v.call(name, input);
        if (!result.ok) throw new Error(`${name} failed: ${JSON.stringify(result.error)}`);
        const tool = v.registry.list().find((candidate) => candidate.name === name);
        if (!tool?.outputSchema) throw new Error(`${name} has no output schema`);
        const schema = toJson(tool.outputSchema) as Record<string, unknown>;
        const serialized = JSON.stringify(schema);
        for (const field of ["key", "valid_from", "valid_to", "superseded_by"])
          expect(serialized).toContain(`"${field}"`);
        const validation = new AjvJsonSchemaValidator().getValidator(schema as never)(
          JSON.parse(JSON.stringify(result.data)),
        );
        expect(validation.valid, JSON.stringify(validation.errorMessage)).toBe(true);
      }
    } finally {
      v.cleanup();
    }
  });
});
