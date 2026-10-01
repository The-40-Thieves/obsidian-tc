// GH #1027: `response_format` across the tool surface, end to end through dispatch. Covers
//   - parity: with no param and no config, every touched tool returns exactly the pre-#1027 payload
//     (detailed, byte-identical), and an explicit "detailed" / legacy "full" says the same thing;
//   - the concise shapes;
//   - safety signals (quality_warning, poison_assessment, redactions, blast radius) survive concise;
//   - precedence through the real dispatch path (explicit > alias > config default > detailed);
//   - errors are never trimmed.
// The ajv check against the ADVERTISED JSON schema lives in response-format-ajv.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dataOf,
  makeWorld,
  runScenario,
  SCENARIOS,
  type Scenario,
  type World,
} from "./response-format-fixture";
import { topLevelShape } from "./schema-introspect";

// Every case builds fresh vaults through the real registry; under load that outgrows the 5 s default.
vi.setConfig({ testTimeout: 60_000 });

const worlds: World[] = [];
async function world(rf?: "concise" | "detailed"): Promise<World> {
  const w = await makeWorld(rf);
  worlds.push(w);
  return w;
}
afterEach(() => {
  for (const w of worlds.splice(0)) w.cleanup();
});

const scenario = (name: string): Scenario => {
  const s = SCENARIOS.find((x) => x.name === name);
  if (!s) throw new Error(`no scenario ${name}`);
  return s;
};
/** mtime/ctime legitimately differ between two fresh worlds. */
const strip = (d: unknown): unknown =>
  JSON.parse(JSON.stringify(d, (k, v) => (k === "stat" ? undefined : v)));
const keys = (o: unknown): string[] => Object.keys(o as object).sort();
const items = (d: Record<string, unknown>, field: string): Array<Record<string, unknown>> =>
  d[field] as Array<Record<string, unknown>>;

/** Run `s` with `extra` args in a world appropriate for it (fresh per call when it mutates). */
async function call(s: Scenario, extra: Record<string, unknown>, rf?: "concise" | "detailed") {
  const w = await world(rf);
  return dataOf(await runScenario(w, s, extra));
}

describe("parity: unset == explicit detailed == legacy full, byte for byte", () => {
  for (const s of SCENARIOS) {
    it(`${s.name}`, async () => {
      const unset = strip(await call(s, {}));
      const explicit = strip(await call(s, { response_format: "detailed" }));
      expect(explicit).toEqual(unset);
      expect(JSON.stringify(explicit)).toBe(JSON.stringify(unset));
      const legacy = strip(await call(s, { verbosity: "full" }));
      expect(legacy).toEqual(unset);
    });
  }
});

describe("parity: detailed output keeps exactly the pre-#1027 field set", () => {
  it("read_note", async () => {
    const d = await call(scenario("read_note"), {});
    expect(keys(d)).toEqual(
      [
        "body",
        "content",
        "content_hash",
        "frontmatter",
        "has_frontmatter",
        "path",
        "stat",
        "vault",
      ].sort(),
    );
    const a = await call(scenario("read_note (anchor)"), {});
    expect(keys(a)).toContain("section");
    expect(keys(a)).toContain("content");
  });

  it("read_notes", async () => {
    const d = await call(scenario("read_notes"), {});
    expect(keys(d)).toEqual(["errors", "next_cursor", "notes", "vault"]);
    expect(keys(items(d, "notes")[0])).toEqual([
      "body",
      "content",
      "content_hash",
      "frontmatter",
      "path",
    ]);
  });

  it("write_note / append_note", async () => {
    expect(keys(await call(scenario("write_note (create)"), {}))).toEqual([
      "bytes_written",
      "content_hash",
      "created",
      "mode_used",
      "path",
      "poison_assessment",
      "prev_hash",
      "quality_warning",
      "vault",
    ]);
    expect(keys(await call(scenario("append_note (flagged note)"), {}))).toEqual([
      "bytes_written",
      "content_hash",
      "created",
      "path",
      "poison_assessment",
      "prev_hash",
      "quality_warning",
      "vault",
    ]);
  });

  it("patch_note / update_frontmatter", async () => {
    expect(keys(await call(scenario("patch_note (replace_text, flagged note)"), {}))).toEqual([
      "anchor",
      "bytes_removed",
      "content_hash",
      "lines_removed",
      "operation",
      "path",
      "prev_hash",
      "quality_warning",
      "target_heading",
      "vault",
    ]);
    expect(keys(await call(scenario("update_frontmatter"), {}))).toEqual([
      "content_hash",
      "created",
      "frontmatter",
      "operation",
      "path",
      "prev_hash",
      "vault",
    ]);
  });

  it("find_notes_by_property / find_unresolved_links", async () => {
    const f = await call(scenario("find_notes_by_property"), {});
    expect(keys(items(f, "matches")[0])).toEqual(["path", "value"]);
    const u = await call(scenario("find_unresolved_links"), {});
    expect(keys(items(u, "unresolved")[0])).toEqual([
      "col",
      "kind",
      "line",
      "source_path",
      "target",
    ]);
  });

  it("search family", async () => {
    expect(keys(items(await call(scenario("search_text"), {}), "items")[0])).toEqual([
      "col",
      "line",
      "path",
      "score",
      "snippet",
    ]);
    expect(keys(items(await call(scenario("search_regex"), {}), "items")[0])).toEqual([
      "col",
      "line",
      "match",
      "path",
      "snippet",
    ]);
    const sem = keys(items(await call(scenario("search_semantic"), {}), "items")[0]);
    expect(sem).toEqual(
      expect.arrayContaining(["chunk_id", "content", "embedding_model", "path", "score"]),
    );
    expect(keys(items(await call(scenario("search_jsonlogic"), {}), "items")[0])).toEqual([
      "matched",
      "path",
    ]);
  });

  it("note_quality_report", async () => {
    const d = await call(scenario("note_quality_report"), {});
    expect(keys(d)).toEqual(["available", "computed_at", "count", "notes", "vault"]);
    expect(keys(items(d, "notes")[0])).toEqual(
      [
        "activation_conflict",
        "age_days",
        "chunk_count",
        "citations",
        "contradictions_open",
        "dup_chunk_count",
        "dup_ratio",
        "flags",
        "in_degree",
        "last_retrieved_at",
        "observed_retrievals",
        "out_degree",
        "path",
        "quality_score",
        "retrievals",
        "score_version",
        "tombstoned",
      ].sort(),
    );
  });
});

describe("concise shapes", () => {
  it("every scenario keeps its shape floor and is strictly smaller (or equal) than detailed", async () => {
    for (const s of SCENARIOS) {
      const detailed = await call(s, { response_format: "detailed" });
      const concise = await call(s, { response_format: "concise" });
      for (const k of s.conciseKeys) expect(keys(concise), `${s.name} keeps ${k}`).toContain(k);
      expect(JSON.stringify(concise).length, s.name).toBeLessThanOrEqual(
        JSON.stringify(detailed).length,
      );
    }
  });

  it("read_note: body without the frontmatter block, hash kept", async () => {
    const d = await call(scenario("read_note"), { response_format: "concise" });
    expect(keys(d)).toEqual(["body", "content_hash", "path", "vault"]);
    expect(d.body).toContain("# Alpha");
    expect(d.body).not.toContain("title: Alpha");
    const full = await call(scenario("read_note"), {});
    expect(d.content_hash).toBe(full.content_hash);
  });

  it("read_note with an anchor: the section plus the whole-note hash, no body", async () => {
    const d = await call(scenario("read_note (anchor)"), { response_format: "concise" });
    expect(keys(d)).toEqual(["content_hash", "path", "section", "vault"]);
    expect((d.section as { text: string }).text).toContain("section text");
    const full = await call(scenario("read_note (anchor)"), {});
    expect(d.content_hash).toBe(full.content_hash);
    expect(d.section).toEqual(full.section);
  });

  it("read_notes: entries are {path, body, content_hash}; per-path errors are untouched", async () => {
    const d = await call(scenario("read_notes"), { response_format: "concise" });
    expect(keys(d)).toEqual(["errors", "next_cursor", "notes", "vault"]);
    for (const n of items(d, "notes")) expect(keys(n)).toEqual(["body", "content_hash", "path"]);
    const full = await call(scenario("read_notes"), {});
    expect(d.errors).toEqual(full.errors);
    expect(items(d, "errors")).toHaveLength(1);
  });

  it("write acks shrink to {vault, path, content_hash} when nothing needs flagging", async () => {
    const hashOf = async (name: string) =>
      (await call(scenario(name), { response_format: "detailed" })).content_hash;
    for (const name of [
      "write_note (create)",
      "write_note (agent_synthesis, clean)",
      "append_note (clean scored note)",
      "update_frontmatter",
    ]) {
      const d = await call(scenario(name), { response_format: "concise" });
      expect(keys(d), name).toEqual(["content_hash", "path", "vault"]);
      expect(d.content_hash, name).toBe(await hashOf(name));
    }
    const p = await call(scenario("patch_note (append)"), { response_format: "concise" });
    expect(keys(p)).toEqual(["content_hash", "path", "vault"]);
  });

  it("find_notes_by_property and the search family: concise equals the legacy terse projection", async () => {
    for (const name of [
      "find_notes_by_property",
      "search_text",
      "search_regex",
      "search_semantic",
      "search_jsonlogic",
      "search_vault",
    ]) {
      const s = scenario(name);
      const concise = await call(s, { response_format: "concise" });
      const terse = await call(s, { verbosity: "terse" });
      expect(strip(concise), name).toEqual(strip(terse));
    }
    const t = await call(scenario("search_text"), { response_format: "concise" });
    expect(keys(items(t, "items")[0])).toEqual(["path", "score", "snippet"]);
    const f = await call(scenario("find_notes_by_property"), { response_format: "concise" });
    expect(items(f, "matches")).toEqual([{ path: "a.md" }]);
  });

  it("find_unresolved_links: {source_path, target, line} per item", async () => {
    const d = await call(scenario("find_unresolved_links"), { response_format: "concise" });
    expect(d.total).toBe(2);
    for (const u of items(d, "unresolved"))
      expect(keys(u)).toEqual(["line", "source_path", "target"]);
  });

  it("note_quality_report: {path, quality_score, flags} per note, conflict only when true", async () => {
    const d = await call(scenario("note_quality_report"), { response_format: "concise" });
    expect(d.available).toBe(true);
    expect(d.count).toBe(3);
    const a = items(d, "notes").find((n) => n.path === "a.md");
    expect(a).toEqual({ path: "a.md", quality_score: 0.25, flags: ["stale_edit", "orphan"] });
  });
});

describe("safety signals survive concise", () => {
  it("write_note keeps a non-empty quality_warning and a suspect poison_assessment", async () => {
    const flagged = await call(scenario("write_note (flagged path)"), {
      response_format: "concise",
    });
    expect(keys(flagged)).toEqual(["content_hash", "path", "quality_warning", "vault"]);
    expect((flagged.quality_warning as { flags: string[] }).flags).toEqual(["duplicate"]);

    const synth = await call(scenario("write_note (agent_synthesis, suspect)"), {
      response_format: "concise",
    });
    expect(keys(synth)).toEqual(["content_hash", "path", "poison_assessment", "vault"]);
    expect((synth.poison_assessment as { risk: string }).risk).toBe("suspect");
  });

  it("append_note keeps the flagged note's quality_warning; a clean scored note drops it", async () => {
    const flagged = await call(scenario("append_note (flagged note)"), {
      response_format: "concise",
    });
    expect((flagged.quality_warning as { flags: string[] }).flags).toEqual([
      "stale_edit",
      "orphan",
    ]);
    const clean = await call(scenario("append_note (clean scored note)"), {
      response_format: "concise",
    });
    expect(clean).not.toHaveProperty("quality_warning");
  });

  it("patch_note keeps quality_warning and the blast radius when something was removed", async () => {
    const d = await call(scenario("patch_note (replace_text, flagged note)"), {
      response_format: "concise",
    });
    expect(keys(d)).toEqual([
      "bytes_removed",
      "content_hash",
      "lines_removed",
      "path",
      "quality_warning",
      "vault",
    ]);
    expect(d.lines_removed).toBe(1);
  });

  it("write_note, append_note and patch_note keep `redactions` under memoryDefense redact mode", async () => {
    const { makeTestVault } = await import("./m1-helpers");
    // Assembled at runtime so no literal in source matches a secret pattern.
    const secret = ["gh", "p_", "M1n2B3v4C5x6Z7a8S9d0F1g2H3j4K5l6"].join("");
    const v = makeTestVault({
      files: { "e.md": "# E\n\nbody\n" },
      memoryDefense: { mode: "redact", pii: false },
    });
    try {
      const w = dataOf(
        await v.call("write_note", {
          vault: "test",
          path: "s.md",
          content: secret,
          response_format: "concise",
        }),
      );
      expect(keys(w)).toEqual(["content_hash", "path", "redactions", "vault"]);
      expect(w.redactions).toBe(1);
      const ap = dataOf(
        await v.call("append_note", {
          vault: "test",
          path: "e.md",
          content: secret,
          response_format: "concise",
        }),
      );
      expect(ap.redactions).toBe(1);
      const pa = dataOf(
        await v.call("patch_note", {
          vault: "test",
          path: "e.md",
          operation: "append",
          anchor: { type: "heading", heading: "E" },
          content: secret,
          response_format: "concise",
        }),
      );
      expect(pa.redactions).toBe(1);
    } finally {
      v.cleanup();
    }
  });
});

describe("precedence through dispatch: explicit > alias > config default > detailed", () => {
  const s = () => scenario("append_note (clean scored note)");

  it("no param, no config -> detailed", async () => {
    expect(keys(await call(s(), {}))).toContain("bytes_written");
  });

  it("config concise, no param -> concise", async () => {
    expect(keys(await call(s(), {}, "concise"))).toEqual(["content_hash", "path", "vault"]);
  });

  it("config concise + explicit detailed -> detailed", async () => {
    expect(keys(await call(s(), { response_format: "detailed" }, "concise"))).toContain(
      "bytes_written",
    );
  });

  it("config concise + legacy full -> detailed (the alias beats the default)", async () => {
    const r = await call(scenario("search_text"), { verbosity: "full" }, "concise");
    expect(keys(items(r, "items")[0])).toContain("line");
  });

  it("config detailed + legacy terse -> concise, and explicit detailed beats terse", async () => {
    const t = await call(scenario("search_text"), { verbosity: "terse" }, "detailed");
    expect(keys(items(t, "items")[0])).toEqual(["path", "score", "snippet"]);
    const d = await call(
      scenario("search_text"),
      { verbosity: "terse", response_format: "detailed" },
      "concise",
    );
    expect(keys(items(d, "items")[0])).toContain("line");
  });

  it("the config default reaches every domain (m1 notes, m1 frontmatter/links, m2, m8)", async () => {
    for (const s of SCENARIOS) {
      const viaConfig = strip(await call(s, {}, "concise"));
      const viaParam = strip(await call(s, { response_format: "concise" }));
      expect(viaConfig, s.name).toEqual(viaParam);
    }
  });
});

describe("errors are never trimmed", () => {
  it("a failing call returns the identical error envelope in concise and detailed", async () => {
    const w = await world();
    for (const [tool, args] of [
      ["read_note", { vault: "test", path: "missing.md" }],
      ["write_note", { vault: "test", path: "a.md", content: "x", mode: "create" }],
      [
        "patch_note",
        {
          vault: "test",
          path: "missing.md",
          operation: "append",
          anchor: { type: "frontmatter" },
          content: "x",
        },
      ],
    ] as const) {
      const a = await w.m1.call(tool, { ...args, response_format: "detailed" });
      const b = await w.m1.call(tool, { ...args, response_format: "concise" });
      expect(a.ok, tool).toBe(false);
      expect(b.ok, tool).toBe(false);
      if (!a.ok && !b.ok) expect(b.error, tool).toEqual(a.error);
    }
  });
});

describe("the parameter is advertised", () => {
  it("every touched tool's input schema accepts response_format and the legacy verbosity alias", async () => {
    const w = await world();
    for (const s of SCENARIOS) {
      const reg =
        s.domain === "m1" ? w.m1.registry : s.domain === "m2" ? w.m2.registry : w.m8.registry;
      const def = reg.list().find((t) => t.name === s.tool);
      expect(def, s.tool).toBeDefined();
      const props = Object.keys(topLevelShape(def?.inputSchema) ?? {});
      expect(props, s.tool).toContain("response_format");
      expect(props, s.tool).toContain("verbosity");
    }
  });
});
