// memory.supersededInNote (per vault, default true). A corrected observation's old text lives in
// the materialized note under `## Superseded` by default, so the indexer chunks and FTS-indexes it.
// With `false` the section is omitted: the note holds only current facts, the closed interval stays
// in SQLite, and get_entity with as_of still returns it. Real SQLite, real indexer, real text search.
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { VaultConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { parseEntityNote } from "../src/memory/materialize";
import { indexVault } from "../src/search/indexer";
import { buildRepresentationManifest } from "../src/search/representation";
import { searchTextIndexed, type TextOptions } from "../src/search/text";
import { type M5Vault, makeM5Vault } from "./m5-helpers";

const V = "test";
const NOTE = "memory/person/Maya Chen.md";
const OLD = "Leads the design team";
const NEW = "Leads the product team";
const LISBON = "Based in Lisbon";

interface Obs {
  observation_id: string;
  text: string;
  valid_from: number;
  valid_to: number | null;
}

function data<T>(r: ToolResult): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.data as T;
}

/** Create Maya at t=100 with two facts, then correct the first one at t=200. */
async function mayaCorrected(v: M5Vault): Promise<string> {
  const created = data<{ entity_id: string; observations: Obs[] }>(
    await v.call(
      "create_entity",
      { vault: V, type: "person", name: "Maya Chen", observations: [OLD, LISBON] },
      { now: () => 100 },
    ),
  );
  const design = created.observations[0] as Obs;
  data(
    await v.call(
      "update_observation",
      {
        vault: V,
        entity_id: created.entity_id,
        observation_id: design.observation_id,
        observation: NEW,
      },
      { now: () => 200 },
    ),
  );
  return created.entity_id;
}

async function observationsAt(v: M5Vault, entityId: string, asOf: number): Promise<Obs[]> {
  return data<{ observations: Obs[] }>(
    await v.call("get_entity", { vault: V, entity_id: entityId, as_of: asOf }),
  ).observations;
}

const sectionOf = (note: string, heading: string): string =>
  note.split(`## ${heading}`)[1]?.split(/\n## /)[0] ?? "";

describe("memory.supersededInNote (per vault, default true)", () => {
  it("default keeps the corrected fact under ## Superseded when the option is unset", async () => {
    const v = makeM5Vault();
    try {
      await mayaCorrected(v);
      const note = v.read(NOTE);
      expect(note).toContain("## Superseded");
      expect(sectionOf(note, "Superseded")).toContain(OLD);
      expect(sectionOf(note, "Observations")).toContain(NEW);
    } finally {
      v.cleanup();
    }
  });

  it("false omits the Superseded section and keeps the current text in a valid entity note", async () => {
    const v = makeM5Vault({ supersededInNote: false });
    try {
      const entityId = await mayaCorrected(v);
      const note = v.read(NOTE);
      expect(note).not.toContain("## Superseded");
      expect(note).not.toContain(OLD);
      expect(sectionOf(note, "Observations")).toContain(NEW);
      const parsed = parseEntityNote(note);
      expect(parsed.entityId).toBe(entityId);
      expect(parsed.entityType).toBe("person");
      expect(parsed.name).toBe("Maya Chen");
      expect(parsed.observations).toEqual([LISBON, NEW]);
    } finally {
      v.cleanup();
    }
  });

  it("as_of before the correction still returns the old value with supersededInNote false", async () => {
    const v = makeM5Vault({ supersededInNote: false });
    try {
      const entityId = await mayaCorrected(v);
      const before = await observationsAt(v, entityId, 150);
      expect(before.map((o) => o.text)).toContain(OLD);
      const after = await observationsAt(v, entityId, 300);
      expect(after.map((o) => o.text)).not.toContain(OLD);
      expect(after.map((o) => o.text)).toContain(NEW);
    } finally {
      v.cleanup();
    }
  });

  it("text search after index_vault does not return the superseded text when supersededInNote is false", async () => {
    const v = makeM5Vault({ supersededInNote: false });
    try {
      await mayaCorrected(v);
      const provider = fakeEmbeddingProvider({ dimensions: 32 });
      await indexVault({
        db: v.db,
        provider,
        representation: buildRepresentationManifest(provider, {}),
        vaultId: V,
        root: v.root,
        isReadable: () => true,
      });
      const opts: TextOptions = { query: "design", limit: 5000, isReadable: () => true };
      // The FTS path ran (not the disk fallback), so this is the index the issue complains about.
      const old = searchTextIndexed(v.db, V, v.root, opts);
      expect(old).not.toBeNull();
      expect(old?.map((h) => h.path)).not.toContain(NOTE);
      // Control: the current text is indexed, so the empty result above is not a dead index.
      const current = searchTextIndexed(v.db, V, v.root, { ...opts, query: "product" });
      expect(current?.map((h) => h.path)).toContain(NOTE);
    } finally {
      v.cleanup();
    }
  });

  it("config: memory.supersededInNote defaults to true and accepts false", () => {
    const memory = VaultConfigSchema.shape.memory.unwrap();
    expect(memory.parse({}).supersededInNote).toBe(true);
    expect(memory.parse({ supersededInNote: false }).supersededInNote).toBe(false);
  });
});
