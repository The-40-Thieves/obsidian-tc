// THE-1130 — validity intervals on memory observations. Covers: supersede (prior closed, new
// open, BOTH texts retained in the note under Observations/Superseded), unkeyed observations
// never supersede, explicit stand-alone retirement (valid_to with no new text), as_of before/
// after a supersession through BOTH get_entity and query_entity_graph, and the input validation
// the ticket calls out (key regex, valid_to > valid_from, observation required unless key+valid_to).
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { describe, expect, it } from "vitest";
import { toJson } from "../src/mcp/facade";
import { makeM5Vault } from "./m5-helpers";

async function createEntity(
  v: ReturnType<typeof makeM5Vault>,
  type: string,
  name: string,
): Promise<string> {
  const r = await v.call("create_entity", { vault: "test", type, name }, { now: () => 100 });
  if (!r.ok) throw new Error(`create_entity failed: ${JSON.stringify(r.error)}`);
  return (r.data as { entity_id: string }).entity_id;
}

interface ObsOut {
  text: string;
  key: string | null;
  valid_from: number;
  valid_to: number | null;
  superseded_by: string | null;
}

describe("add_observation: supersede via key", () => {
  it("closes the prior open interval and opens a new one; both texts retained; note shows both sections", async () => {
    const v = makeM5Vault();
    try {
      const id = await createEntity(v, "person", "Ada");
      const first = await v.call(
        "add_observation",
        { vault: "test", entity_id: id, observation: "works at IBM", key: "employer" },
        { now: () => 200 },
      );
      expect(first.ok).toBe(true);

      const second = await v.call(
        "add_observation",
        { vault: "test", entity_id: id, observation: "works at Google", key: "employer" },
        { now: () => 300 },
      );
      expect(second.ok).toBe(true);
      if (second.ok)
        expect((second.data as { observation_count: number }).observation_count).toBe(2);

      const get = await v.call("get_entity", { vault: "test", entity_id: id });
      expect(get.ok).toBe(true);
      if (get.ok) {
        // Default as_of (now) shows only the currently-open one.
        const obs = (get.data as { observations: ObsOut[] }).observations;
        expect(obs).toEqual([
          {
            text: "works at Google",
            key: "employer",
            valid_from: 300,
            valid_to: null,
            superseded_by: null,
          },
        ]);
      }

      const note = v.read("memory/person/Ada.md");
      expect(note).toContain("## Observations");
      expect(note).toContain("- [employer] works at Google");
      expect(note).toContain("## Superseded");
      expect(note).toContain("- [employer] works at IBM (valid 1970-01-01");
      // Both bullets present — the prior fact's TEXT was never deleted.
      expect(note).toContain("works at IBM");
      expect(note).toContain("works at Google");
    } finally {
      v.cleanup();
    }
  });

  it("an unkeyed observation never supersedes — both stay open", async () => {
    const v = makeM5Vault();
    try {
      const id = await createEntity(v, "person", "Ada");
      await v.call(
        "add_observation",
        { vault: "test", entity_id: id, observation: "likes tea" },
        { now: () => 200 },
      );
      await v.call(
        "add_observation",
        { vault: "test", entity_id: id, observation: "likes coffee" },
        { now: () => 300 },
      );
      const get = await v.call("get_entity", { vault: "test", entity_id: id });
      if (!get.ok) throw new Error("get failed");
      const obs = (get.data as { observations: ObsOut[] }).observations;
      expect(obs).toHaveLength(2);
      expect(obs.every((o) => o.valid_to === null)).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("a different key never supersedes another key's open observation", async () => {
    const v = makeM5Vault();
    try {
      const id = await createEntity(v, "person", "Ada");
      await v.call(
        "add_observation",
        { vault: "test", entity_id: id, observation: "works at IBM", key: "employer" },
        { now: () => 200 },
      );
      await v.call(
        "add_observation",
        { vault: "test", entity_id: id, observation: "lives in London", key: "residence" },
        { now: () => 300 },
      );
      const get = await v.call("get_entity", { vault: "test", entity_id: id });
      if (!get.ok) throw new Error("get failed");
      const obs = (get.data as { observations: ObsOut[] }).observations;
      expect(obs).toHaveLength(2);
      expect(obs.every((o) => o.valid_to === null)).toBe(true);
    } finally {
      v.cleanup();
    }
  });
});

describe("add_observation: explicit retirement (no new text)", () => {
  it("closes the open interval for a key with no replacement — no new text appended", async () => {
    const v = makeM5Vault();
    try {
      const id = await createEntity(v, "person", "Ada");
      await v.call(
        "add_observation",
        { vault: "test", entity_id: id, observation: "works at IBM", key: "employer" },
        { now: () => 200 },
      );
      const retire = await v.call(
        "add_observation",
        { vault: "test", entity_id: id, key: "employer", valid_to: new Date(300).toISOString() },
        { now: () => 300 },
      );
      expect(retire.ok).toBe(true);
      if (retire.ok)
        // Unchanged from before the retirement — no new text was appended.
        expect((retire.data as { observation_count: number }).observation_count).toBe(1);

      const get = await v.call("get_entity", { vault: "test", entity_id: id });
      if (!get.ok) throw new Error("get failed");
      // Default as_of (now) excludes it — it's closed and nothing replaced it.
      expect((get.data as { observations: ObsOut[] }).observations).toEqual([]);

      const note = v.read("memory/person/Ada.md");
      expect(note).toContain("_No observations._");
      expect(note).toContain("## Superseded");
      expect(note).toContain("- [employer] works at IBM");
    } finally {
      v.cleanup();
    }
  });

  it("404s a retirement with no open observation for that key", async () => {
    const v = makeM5Vault();
    try {
      const id = await createEntity(v, "person", "Ada");
      const r = await v.call("add_observation", {
        vault: "test",
        entity_id: id,
        key: "employer",
        valid_to: new Date(300).toISOString(),
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });
});

describe("add_observation: input validation", () => {
  it("rejects a key that fails the regex", async () => {
    const v = makeM5Vault();
    try {
      const id = await createEntity(v, "person", "Ada");
      const r = await v.call("add_observation", {
        vault: "test",
        entity_id: id,
        observation: "x",
        key: "not a key!",
      });
      expect(r.ok).toBe(false);
      // Schema-level rejection (zod's .regex on the input), not a handler-thrown invalid_input.
      if (!r.ok) expect(r.error.code).toBe("validation_error");
    } finally {
      v.cleanup();
    }
  });

  it("requires observation unless key and valid_to are both provided", async () => {
    const v = makeM5Vault();
    try {
      const id = await createEntity(v, "person", "Ada");
      const noText = await v.call("add_observation", { vault: "test", entity_id: id, key: "x" });
      expect(noText.ok).toBe(false);
      // Schema-level rejection (the .superRefine on the input), not a handler-thrown invalid_input.
      if (!noText.ok) expect(noText.error.code).toBe("validation_error");

      const noKey = await v.call("add_observation", {
        vault: "test",
        entity_id: id,
        valid_to: new Date(300).toISOString(),
      });
      expect(noKey.ok).toBe(false);
      if (!noKey.ok) expect(noKey.error.code).toBe("validation_error");
    } finally {
      v.cleanup();
    }
  });

  it("rejects valid_to at or before valid_from on a normal add", async () => {
    const v = makeM5Vault();
    try {
      const id = await createEntity(v, "person", "Ada");
      const r = await v.call("add_observation", {
        vault: "test",
        entity_id: id,
        observation: "x",
        valid_from: new Date(300).toISOString(),
        valid_to: new Date(300).toISOString(),
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });
});

describe("as_of", () => {
  it("get_entity: an as_of before a supersession returns the old fact; after, the new one", async () => {
    const v = makeM5Vault();
    try {
      const id = await createEntity(v, "person", "Ada");
      await v.call(
        "add_observation",
        { vault: "test", entity_id: id, observation: "works at IBM", key: "employer" },
        { now: () => 200 },
      );
      await v.call(
        "add_observation",
        { vault: "test", entity_id: id, observation: "works at Google", key: "employer" },
        { now: () => 300 },
      );

      const before = await v.call("get_entity", { vault: "test", entity_id: id, as_of: 250 });
      if (!before.ok) throw new Error("get failed");
      expect((before.data as { observations: ObsOut[] }).observations.map((o) => o.text)).toEqual([
        "works at IBM",
      ]);

      const after = await v.call("get_entity", { vault: "test", entity_id: id, as_of: 300 });
      if (!after.ok) throw new Error("get failed");
      expect((after.data as { observations: ObsOut[] }).observations.map((o) => o.text)).toEqual([
        "works at Google",
      ]);

      // Exactly at the old boundary (valid_to === as_of) — half-open interval excludes it.
      const atBoundary = await v.call("get_entity", { vault: "test", entity_id: id, as_of: 300 });
      if (!atBoundary.ok) throw new Error("get failed");
      expect(
        (atBoundary.data as { observations: ObsOut[] }).observations.some(
          (o) => o.text === "works at IBM",
        ),
      ).toBe(false);
    } finally {
      v.cleanup();
    }
  });

  it("query_entity_graph: as_of filters each node's observations the same way get_entity does", async () => {
    const v = makeM5Vault();
    try {
      const a = await createEntity(v, "person", "A");
      const b = await createEntity(v, "person", "B");
      await v.call("link_entities", {
        vault: "test",
        source_id: a,
        target_id: b,
        relation_type: "knows",
      });
      await v.call(
        "add_observation",
        { vault: "test", entity_id: b, observation: "works at IBM", key: "employer" },
        { now: () => 200 },
      );
      await v.call(
        "add_observation",
        { vault: "test", entity_id: b, observation: "works at Google", key: "employer" },
        { now: () => 300 },
      );

      const before = await v.call("query_entity_graph", {
        vault: "test",
        seed_entity_id: a,
        as_of: 250,
      });
      if (!before.ok) throw new Error("query failed");
      const bBefore = (
        before.data as { items: { entity_id: string; observations: ObsOut[] }[] }
      ).items.find((n) => n.entity_id === b);
      expect(bBefore?.observations.map((o) => o.text)).toEqual(["works at IBM"]);

      const after = await v.call("query_entity_graph", {
        vault: "test",
        seed_entity_id: a,
        as_of: 300,
      });
      if (!after.ok) throw new Error("query failed");
      const bAfter = (
        after.data as { items: { entity_id: string; observations: ObsOut[] }[] }
      ).items.find((n) => n.entity_id === b);
      expect(bAfter?.observations.map((o) => o.text)).toEqual(["works at Google"]);
    } finally {
      v.cleanup();
    }
  });

  it("default as_of (no input) is now — a fact added after an explicit past as_of is excluded", async () => {
    const v = makeM5Vault();
    try {
      const id = await createEntity(v, "person", "Ada");
      await v.call(
        "add_observation",
        { vault: "test", entity_id: id, observation: "added later" },
        { now: () => 500 },
      );
      const r = await v.call("get_entity", { vault: "test", entity_id: id, as_of: 100 });
      if (!r.ok) throw new Error("get failed");
      expect((r.data as { observations: ObsOut[] }).observations).toEqual([]);
    } finally {
      v.cleanup();
    }
  });
});

// THE-1073 lesson (reference_obsidian_tc_zod_safeparse_strips_but_ajv_rejects_extra_keys): zod's
// safeParse silently strips a field the output schema doesn't declare, so it alone cannot prove
// the wire payload is valid. Validate the ACTUAL emitted payload against the advertised
// outputSchema the way the MCP SDK's own client does — with ajv, not zod.
describe("get_entity / query_entity_graph: ajv-validated output payload", () => {
  it("get_entity's observations (with key/valid_from/valid_to/superseded_by) pass ajv against the advertised schema", async () => {
    const v = makeM5Vault();
    try {
      const id = await createEntity(v, "person", "Ada");
      await v.call(
        "add_observation",
        { vault: "test", entity_id: id, observation: "v1", key: "k" },
        { now: () => 200 },
      );
      await v.call(
        "add_observation",
        { vault: "test", entity_id: id, observation: "v2", key: "k" },
        { now: () => 300 },
      );
      const get = await v.call("get_entity", {
        vault: "test",
        entity_id: id,
        as_of: 1_000_000,
        include_retired: true,
      });
      if (!get.ok) throw new Error("get failed");

      const tool = v.registry.list().find((t) => t.name === "get_entity");
      if (!tool?.outputSchema) throw new Error("get_entity not registered / no outputSchema");
      const schema = toJson(tool.outputSchema);
      const validate = new AjvJsonSchemaValidator().getValidator(schema as never);
      const result = validate(JSON.parse(JSON.stringify(get.data)));
      expect(result.valid).toBe(true);
    } finally {
      v.cleanup();
    }
  });
});
