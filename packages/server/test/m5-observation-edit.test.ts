// update_observation: correct or retire ONE observation by its stable `observation_id`, with no
// key needed. RED fixture: the write-ergonomics eval's `memory-observation` task verbatim — an
// entity created with keyless observations, one of which is wrong (0/3 before: add_observation
// supersedes only by key and nothing else could edit or remove a fact).

import { readFileSync } from "node:fs";
import { type ToolResult, VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import type { CallerContext } from "../src/mcp/registry";
import { type M5Vault, makeM5Vault } from "./m5-helpers";

const V = VaultId.parse("test");
const NOTE = "memory/person/Maya Chen.md";
const SETUP: Partial<CallerContext> = {
  acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
  now: () => 100,
};

interface Obs {
  observation_id: string;
  text: string;
  key?: string | null;
  valid_to?: number | null;
  superseded_by?: string | null;
}

const data = <T>(r: ToolResult): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.data as T;
};

async function mayaEntity(
  v: M5Vault,
  over: Record<string, unknown> = {},
  ctx: Partial<CallerContext> = { now: () => 100 },
): Promise<{ entity_id: string; observations: Obs[] }> {
  return data(
    await v.call(
      "create_entity",
      {
        vault: V,
        type: "person",
        name: "Maya Chen",
        observations: ["Leads the design team", "Based in Lisbon"],
        ...over,
      },
      ctx,
    ),
  );
}

const read = async (v: M5Vault, entity_id: string, extra: Record<string, unknown> = {}) =>
  data<{ observations: Obs[] }>(await v.call("get_entity", { vault: V, entity_id, ...extra }));

const sectionOf = (note: string, heading: string): string =>
  note.split(`## ${heading}`)[1]?.split(/\n## /)[0] ?? "";

describe("update_observation: the write-ergonomics `memory-observation` fixture", () => {
  it("corrects a keyless observation created by create_entity and keeps the other fact", async () => {
    const v = makeM5Vault();
    try {
      const created = await mayaEntity(v);
      // The ids come back from create_entity itself, so no extra read is needed to find them.
      expect(created.observations.map((o) => o.text)).toEqual([
        "Leads the design team",
        "Based in Lisbon",
      ]);
      const design = created.observations[0] as Obs;

      const r = await v.call(
        "update_observation",
        {
          vault: V,
          entity_id: created.entity_id,
          observation_id: design.observation_id,
          observation: "Leads the product team",
        },
        { now: () => 200 },
      );
      expect(data<{ action: string }>(r).action).toBe("corrected");

      const texts = (await read(v, created.entity_id)).observations.map((o) => o.text);
      expect(texts).toEqual(["Based in Lisbon", "Leads the product team"]);

      // The eval's own check on the materialized note's Observations section.
      const obs = sectionOf(v.read(NOTE), "Observations");
      expect(obs).toMatch(/Leads the product team/);
      expect(obs).not.toMatch(/Leads the design team/);
      expect(obs).toMatch(/Lisbon/);
      expect(sectionOf(v.read(NOTE), "Superseded")).toMatch(/Leads the design team/);
    } finally {
      v.cleanup();
    }
  });

  it("add_observation alone leaves the stale fact current (the failing baseline route)", async () => {
    const v = makeM5Vault();
    try {
      const created = await mayaEntity(v);
      await v.call("add_observation", {
        vault: V,
        entity_id: created.entity_id,
        observation: "Leads the product team",
      });
      const texts = (await read(v, created.entity_id)).observations.map((o) => o.text);
      expect(texts).toContain("Leads the design team");
    } finally {
      v.cleanup();
    }
  });
});

describe("observation ids", () => {
  it("documents the compatibility-preserved cross-boundary activity residual", () => {
    const security = readFileSync(new URL("../../../SECURITY.md", import.meta.url), "utf8");
    expect(security).toMatch(/observation IDs are globally sequential/i);
    expect(security).toMatch(/intervening activity/i);
  });

  it("are stable across reads and writes, and the same from create_entity and get_entity", async () => {
    const v = makeM5Vault();
    try {
      const created = await mayaEntity(v);
      const first = (await read(v, created.entity_id)).observations;
      expect(first.map((o) => o.observation_id)).toEqual(
        created.observations.map((o) => o.observation_id),
      );
      const added = data<{ observation_id: string }>(
        await v.call("add_observation", {
          vault: V,
          entity_id: created.entity_id,
          observation: "Speaks Portuguese",
        }),
      );
      const concise = data<{ observations: Obs[] }>(
        await v.call("get_entity", {
          vault: V,
          entity_id: created.entity_id,
          response_format: "concise",
        }),
      );
      expect(concise.observations.map((o) => o.observation_id)).toEqual([
        ...first.map((o) => o.observation_id),
        added.observation_id,
      ]);
      expect(new Set(concise.observations.map((o) => o.observation_id)).size).toBe(3);
    } finally {
      v.cleanup();
    }
  });

  it("exist for observations written before ids were surfaced (derived, no migration)", async () => {
    const v = makeM5Vault();
    try {
      const created = await mayaEntity(v);
      // A keyless row exactly as the pre-existing interval backfill/creation wrote it.
      const row = v.db
        .prepare("SELECT id, key FROM memory_observation_intervals WHERE entity_id = ? ORDER BY id")
        .all(created.entity_id) as Array<{ id: number; key: string | null }>;
      expect(row.map((r) => r.key)).toEqual([null, null]);
      expect(created.observations.map((o) => o.observation_id)).toEqual(
        row.map((r) => `obs_${r.id}`),
      );
    } finally {
      v.cleanup();
    }
  });
});

describe("update_observation: retire", () => {
  it("hides the fact from the default read but keeps it in history and in the note", async () => {
    const v = makeM5Vault();
    try {
      const created = await mayaEntity(v);
      const design = created.observations[0] as Obs;
      const r = data<{ action: string; observation_id?: string; closed_observation_id: string }>(
        await v.call(
          "update_observation",
          {
            vault: V,
            entity_id: created.entity_id,
            observation_id: design.observation_id,
            retire: true,
          },
          { now: () => 300 },
        ),
      );
      expect(r.action).toBe("retired");
      expect(r.observation_id).toBeUndefined();
      expect(r.closed_observation_id).toBe(design.observation_id);

      expect((await read(v, created.entity_id)).observations.map((o) => o.text)).toEqual([
        "Based in Lisbon",
      ]);
      // History: an as_of before the retirement still shows it; nothing was deleted.
      const past = await read(v, created.entity_id, { as_of: 200 });
      expect(past.observations.map((o) => o.text)).toContain("Leads the design team");
      expect(
        v.db
          .prepare("SELECT valid_to, superseded_by FROM memory_observation_intervals WHERE id = ?")
          .get(Number(design.observation_id.slice(4))),
      ).toEqual({ valid_to: 300, superseded_by: null });
      expect(
        v.db
          .prepare("SELECT observations FROM memory_entities WHERE id = ?")
          .get(created.entity_id),
      ).toEqual({ observations: "Leads the design team\nBased in Lisbon" });
      expect(sectionOf(v.read(NOTE), "Observations")).not.toMatch(/design team/);
      expect(sectionOf(v.read(NOTE), "Superseded")).toMatch(/Leads the design team/);
    } finally {
      v.cleanup();
    }
  });

  it("works with materialize:false (SQLite is the source of truth)", async () => {
    const v = makeM5Vault();
    try {
      const created = await mayaEntity(v, { materialize: false });
      const r = await v.call("update_observation", {
        vault: V,
        entity_id: created.entity_id,
        observation_id: (created.observations[1] as Obs).observation_id,
        retire: true,
      });
      expect(r.ok).toBe(true);
      expect(v.exists(NOTE)).toBe(false);
      expect((await read(v, created.entity_id)).observations).toHaveLength(1);
    } finally {
      v.cleanup();
    }
  });
});

describe("update_observation: supersession and keys", () => {
  it("a correction records what replaced the old text and keeps its key", async () => {
    const v = makeM5Vault();
    try {
      const created = await mayaEntity(v, { observations: [] });
      const keyed = data<{ observation_id: string }>(
        await v.call(
          "add_observation",
          { vault: V, entity_id: created.entity_id, observation: "Works at IBM", key: "employer" },
          { now: () => 200 },
        ),
      );
      const fixed = data<{ observation_id: string }>(
        await v.call(
          "update_observation",
          {
            vault: V,
            entity_id: created.entity_id,
            observation_id: keyed.observation_id,
            observation: "Works at Google",
          },
          { now: () => 300 },
        ),
      );
      const now = (await read(v, created.entity_id)).observations;
      expect(now).toEqual([
        expect.objectContaining({
          observation_id: fixed.observation_id,
          text: "Works at Google",
          key: "employer",
          valid_from: 300,
        }),
      ]);
      const old = (await read(v, created.entity_id, { as_of: 250 })).observations;
      expect(old[0]).toMatchObject({ text: "Works at IBM", valid_to: 300 });
      expect(old[0]?.superseded_by).toMatch(/^[0-9a-f]{64}$/);

      // add_observation's key supersession still works, now over the corrected observation.
      await v.call(
        "add_observation",
        { vault: V, entity_id: created.entity_id, observation: "Works at Meta", key: "employer" },
        { now: () => 400 },
      );
      expect((await read(v, created.entity_id)).observations.map((o) => o.text)).toEqual([
        "Works at Meta",
      ]);
    } finally {
      v.cleanup();
    }
  });

  it("add_observation supersession by key is unchanged and returns the new observation_id", async () => {
    const v = makeM5Vault();
    try {
      const created = await mayaEntity(v, { observations: [] });
      const a = data<{ observation_id: string }>(
        await v.call("add_observation", {
          vault: V,
          entity_id: created.entity_id,
          observation: "A",
          key: "k",
        }),
      );
      const b = data<{ observation_id: string }>(
        await v.call("add_observation", {
          vault: V,
          entity_id: created.entity_id,
          observation: "B",
          key: "k",
        }),
      );
      expect(a.observation_id).not.toBe(b.observation_id);
      expect((await read(v, created.entity_id)).observations.map((o) => o.text)).toEqual(["B"]);
    } finally {
      v.cleanup();
    }
  });
});

describe("update_observation: errors", () => {
  it("rejects bad input and unknown, foreign or already-closed observations", async () => {
    const v = makeM5Vault();
    try {
      const a = await mayaEntity(v);
      const other = data<{ entity_id: string; observations: Obs[] }>(
        await v.call("create_entity", {
          vault: V,
          type: "person",
          name: "Other",
          observations: ["x"],
        }),
      );
      const id = (a.observations[0] as Obs).observation_id;
      const base = { vault: V, entity_id: a.entity_id, observation_id: id };
      const code = (r: ToolResult) => (r.ok ? "ok" : r.error.code);

      expect(code(await v.call("update_observation", base))).toBe("validation_error");
      expect(
        code(await v.call("update_observation", { ...base, observation: "x", retire: true })),
      ).toBe("validation_error");
      expect(code(await v.call("update_observation", { ...base, observation: "two\nlines" }))).toBe(
        "validation_error",
      );
      expect(
        code(await v.call("update_observation", { ...base, observation_id: "7", retire: true })),
      ).toBe("validation_error");
      expect(
        code(
          await v.call("update_observation", {
            ...base,
            observation_id: "obs_99999",
            retire: true,
          }),
        ),
      ).toBe("invalid_input");
      // Another entity's real id is as unknown as a made-up one, and nothing was changed.
      expect(
        code(
          await v.call("update_observation", {
            ...base,
            observation_id: (other.observations[0] as Obs).observation_id,
            retire: true,
          }),
        ),
      ).toBe("invalid_input");
      expect((await read(v, other.entity_id)).observations).toHaveLength(1);
      expect(
        code(await v.call("update_observation", { ...base, observation: "Leads the design team" })),
      ).toBe("invalid_input");

      expect(code(await v.call("update_observation", { ...base, retire: true }))).toBe("ok");
      expect(code(await v.call("update_observation", { ...base, retire: true }))).toBe(
        "invalid_input",
      );
      expect(
        code(
          await v.call("update_observation", { ...base, entity_id: "ent_missing", retire: true }),
        ),
      ).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });
});

describe("update_observation: memory ACL", () => {
  const NO_PERSON_WRITES = { writePaths: ["memory/place/**"] };
  const denied = (r: ToolResult) => !r.ok && r.error.code === "acl_denied";

  for (const materialize of [false, true]) {
    it(`needs write on the entity's note path; nothing changes on a denial (materialize=${materialize})`, async () => {
      const v = makeM5Vault({ acl: NO_PERSON_WRITES });
      try {
        const created = await mayaEntity(v, { materialize }, SETUP);
        const obs = created.observations[0] as Obs;
        for (const edit of [{ retire: true }, { observation: "Leads the product team" }]) {
          const r = await v.call("update_observation", {
            vault: V,
            entity_id: created.entity_id,
            observation_id: obs.observation_id,
            ...edit,
          });
          expect(denied(r)).toBe(true);
        }
        expect((await read(v, created.entity_id)).observations).toHaveLength(2);
        expect(
          v.db.prepare("SELECT COUNT(*) AS n FROM memory_observation_intervals").get(),
        ).toEqual({ n: 2 });
      } finally {
        v.cleanup();
      }
    });
  }

  it("an entity the caller cannot read is 'not found', identical to an absent one", async () => {
    const hidden = makeM5Vault({ acl: { readPaths: ["public/**"] } });
    const absent = makeM5Vault({ acl: { readPaths: ["public/**"] } });
    try {
      const created = await mayaEntity(hidden, {}, SETUP);
      const input = {
        vault: V,
        entity_id: created.entity_id,
        observation_id: (created.observations[0] as Obs).observation_id,
        retire: true,
      };
      const a = await hidden.call("update_observation", input);
      const b = await absent.call("update_observation", input);
      expect(a.ok).toBe(false);
      expect(JSON.stringify(a.ok ? a : a.error)).toBe(JSON.stringify(b.ok ? b : b.error));
    } finally {
      hidden.cleanup();
      absent.cleanup();
    }
  });
});

describe("update_observation: memoryDefense", () => {
  it("scans the corrected text like add_observation (block mode refuses, nothing changes)", async () => {
    const v = makeM5Vault({ memoryDefense: { mode: "block", pii: false } });
    try {
      const created = await mayaEntity(v);
      const r = await v.call("update_observation", {
        vault: V,
        entity_id: created.entity_id,
        observation_id: (created.observations[0] as Obs).observation_id,
        observation: "token sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD",
      });
      expect(r.ok).toBe(false);
      expect((await read(v, created.entity_id)).observations).toHaveLength(2);
    } finally {
      v.cleanup();
    }
  });
});
