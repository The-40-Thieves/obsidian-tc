// GH #1027: `response_format` across the tool surface, end to end through dispatch. Covers
//   - parity: with no param and no config, every touched tool returns exactly the pre-#1027 payload
//     (detailed, byte-identical), and an explicit "detailed" / legacy "full" says the same thing;
//   - the concise shapes;
//   - safety signals (quality_warning, poison_assessment, redactions, blast radius) survive concise;
//   - precedence through the real dispatch path (explicit > alias > config default > detailed);
//   - errors are never trimmed.
// The ajv check against the ADVERTISED JSON schema lives in response-format-ajv.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { issueElicitToken } from "../src/elicit";
import { registerM7Tools } from "../src/tools/m7";
import { makeM2Vault } from "./m2-helpers";
import {
  dataOf,
  makeWorld,
  registryOf,
  runScenario,
  SCENARIOS,
  type Scenario,
  type World,
} from "./response-format-fixture";
import { topLevelShape } from "./schema-introspect";
import { makeTempDir, rmTemp } from "./tmp";

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
/** mtime/ctime legitimately differ between two fresh worlds (stat, and list_notes' per-note mtime), and
 *  so does a memory read's wall-clock as_of. */
const strip = (d: unknown): unknown =>
  JSON.parse(
    JSON.stringify(d, (k, v) => (k === "stat" || k === "mtime" || k === "as_of" ? undefined : v)),
  );
const keys = (o: unknown): string[] => Object.keys(o as object).sort();
const items = (d: Record<string, unknown>, field: string): Array<Record<string, unknown>> =>
  d[field] as Array<Record<string, unknown>>;

/** Run `s` with `extra` args in a world appropriate for it (fresh per call when it mutates). */
async function call(s: Scenario, extra: Record<string, unknown>, rf?: "concise" | "detailed") {
  const w = await world(rf);
  return dataOf(await runScenario(w, s, extra));
}

/** A volatile (random ids, wall-clock times) scenario is read-only: run every variant in ONE world. */
async function callAll(
  s: Scenario,
  variants: Array<Record<string, unknown>>,
  rf?: "concise" | "detailed",
) {
  const w = await world(rf);
  const out: Array<Record<string, unknown>> = [];
  for (const extra of variants) out.push(dataOf(await runScenario(w, s, extra)));
  return out;
}

describe("parity: unset == explicit detailed == legacy full, byte for byte", () => {
  for (const s of SCENARIOS) {
    it(`${s.name}`, async () => {
      const [u, e, l] = s.volatile
        ? await callAll(s, [{}, { response_format: "detailed" }, { verbosity: "full" }])
        : [
            await call(s, {}),
            await call(s, { response_format: "detailed" }),
            await call(s, { verbosity: "full" }),
          ];
      const unset = strip(u);
      const explicit = strip(e);
      expect(explicit).toEqual(unset);
      expect(JSON.stringify(explicit)).toBe(JSON.stringify(unset));
      expect(strip(l)).toEqual(unset);
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

  it("read_frontmatter / links / list_notes / read_resources", async () => {
    expect(keys(await call(scenario("read_frontmatter"), {}))).toEqual([
      "content_hash",
      "frontmatter",
      "has_frontmatter",
      "path",
      "vault",
    ]);
    const out = await call(scenario("get_outgoing_links"), {});
    expect(keys(out)).toEqual(["counts", "links", "path", "vault"]);
    expect(keys(items(out, "links")[0])).toEqual([
      "candidates",
      "col",
      "display",
      "heading",
      "kind",
      "line",
      "raw",
      "resolved",
      "target",
      "target_path",
    ]);
    const back = await call(scenario("get_backlinks"), {});
    expect(keys(back)).toEqual(["backlinks", "path", "total", "truncated", "vault"]);
    expect(keys(items(back, "backlinks")[0])).toEqual([
      "col",
      "display",
      "kind",
      "line",
      "raw",
      "source_path",
    ]);
    const list = await call(scenario("list_notes"), {});
    expect(keys(list)).toEqual(["folder", "next_cursor", "notes", "total_returned", "vault"]);
    expect(keys(items(list, "notes")[0])).toEqual(["mtime", "path", "size"]);
    const res = await call(scenario("read_resources"), {});
    const results = items(res, "results");
    expect(keys(results[0])).toEqual(["mimeType", "ok", "text", "uri"]);
    expect(results[0]?.text).toContain("title: Alpha");
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

describe("part 2 concise shapes", () => {
  it("read_frontmatter: has_frontmatter is derivable, so only it goes; null frontmatter stays", async () => {
    const d = await call(scenario("read_frontmatter"), { response_format: "concise" });
    expect(keys(d)).toEqual(["content_hash", "frontmatter", "path", "vault"]);
    expect(d.frontmatter).toEqual({ title: "Alpha", tags: ["x"] });
    const none = await call(scenario("read_frontmatter (no frontmatter)"), {
      response_format: "concise",
    });
    expect(none.frontmatter).toBeNull();
    const full = await call(scenario("read_frontmatter (no frontmatter)"), {});
    expect(full.has_frontmatter).toBe(false);
    expect(none.content_hash).toBe(full.content_hash);
  });

  it("get_outgoing_links: {target, line, resolved} plus only the non-null extras; counts kept", async () => {
    const full = await call(scenario("get_outgoing_links"), {});
    const d = await call(scenario("get_outgoing_links"), { response_format: "concise" });
    expect(d.counts).toEqual(full.counts);
    const links = items(d, "links");
    expect(links).toHaveLength(items(full, "links").length);
    const resolved = links.find((l) => l.target === "b");
    expect(resolved).toEqual({ target: "b", line: 3, resolved: true, target_path: "b.md" });
    const dangling = links.find((l) => l.target === "missing-one");
    expect(dangling).toEqual({ target: "missing-one", line: 3, resolved: false });
  });

  it("get_backlinks: {source_path, line} per backlink; total and truncated kept", async () => {
    const full = await call(scenario("get_backlinks"), {});
    const d = await call(scenario("get_backlinks"), { response_format: "concise" });
    expect(d.total).toBe(full.total);
    expect(d.truncated).toBe(full.truncated);
    expect(d.total).toBeGreaterThan(0);
    expect(items(d, "backlinks")).toEqual(
      items(full, "backlinks").map((b) => ({ source_path: b.source_path, line: b.line })),
    );
  });

  it("list_notes: only the path per note; the cursor survives and pages on", async () => {
    const d = await call(scenario("list_notes"), { response_format: "concise", limit: 2 });
    expect(keys(d)).toEqual(["next_cursor", "notes", "vault"]);
    expect(items(d, "notes")).toEqual([{ path: "a.md" }, { path: "b.md" }]);
    expect(d.next_cursor).toBe("b.md");
    const next = await call(scenario("list_notes"), {
      response_format: "concise",
      limit: 2,
      cursor: d.next_cursor,
    });
    expect(items(next, "notes")).toEqual([{ path: "plain.md" }]);
    expect(next.next_cursor).toBeNull();
  });

  it("read_resources: {ok, uri, text} with the body only; error items untouched", async () => {
    const full = await call(scenario("read_resources"), {});
    const d = await call(scenario("read_resources"), { response_format: "concise" });
    const results = items(d, "results");
    expect(keys(results[0])).toEqual(["ok", "text", "uri"]);
    expect(results[0]?.text).toContain("# Alpha");
    expect(results[0]?.text).not.toContain("title: Alpha");
    // A note with no frontmatter reads back unchanged.
    expect(results[1]?.text).toBe(items(full, "results")[1]?.text);
    expect(results[2]).toEqual(items(full, "results")[2]);
    expect(results[2]?.ok).toBe(false);
    expect(d.next_cursor).toBe(full.next_cursor);
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

describe("part 3 concise shapes", () => {
  /** Run a confirmation-gated tool for real: the elicit_required round trip, then the token. */
  async function confirmed(
    v: World["m1"],
    tool: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const need = await v.call(tool, input);
    if (need.ok || need.error.code !== "elicit_required")
      throw new Error("expected elicit_required");
    const argsHash = String((need.error.details as { args_hash?: string }).args_hash);
    const token = issueElicitToken(v.db, {
      vaultId: v.id,
      toolName: tool,
      argsHash,
      caller: "test",
    });
    return dataOf(await v.call(tool, input, { elicitToken: token }));
  }
  const rewrite = { vault: "test", from_target: "b", to_target: "c", dry_run: false };
  const prune = { vault: "test", path: "a.md", dry_run: false };

  it("rewrite_link real run: counts stay, the echoes and the change list go", async () => {
    const full = await confirmed((await world()).m1, "rewrite_link", rewrite);
    const d = await confirmed((await world()).m1, "rewrite_link", {
      ...rewrite,
      response_format: "concise",
    });
    expect(keys(full)).toEqual([
      "changes",
      "dry_run",
      "from_target",
      "links_rewritten",
      "notes_changed",
      "to_target",
      "vault",
    ]);
    expect(keys(d)).toEqual(["dry_run", "links_rewritten", "notes_changed", "vault"]);
    expect(d.dry_run).toBe(false);
    expect(d.notes_changed).toBe(full.notes_changed);
    expect(d.links_rewritten).toBe(full.links_rewritten);
    expect(d.notes_changed).toBeGreaterThan(0);
  });

  it("rewrite_link dry run keeps the preview (changes) in concise", async () => {
    const d = await call(scenario("rewrite_link (dry run)"), { response_format: "concise" });
    expect(keys(d)).toEqual(["changes", "dry_run", "links_rewritten", "notes_changed", "vault"]);
    expect(items(d, "changes").length).toBe(d.notes_changed);
  });

  it("prune_hub_links real run: removed_count and content_hash stay, removed[] and prev_hash go", async () => {
    const full = await confirmed((await world()).m1, "prune_hub_links", prune);
    const d = await confirmed((await world()).m1, "prune_hub_links", {
      ...prune,
      response_format: "concise",
    });
    expect(keys(full)).toEqual([
      "content_hash",
      "dry_run",
      "path",
      "prev_hash",
      "removed",
      "removed_count",
      "vault",
    ]);
    expect(keys(d)).toEqual(["content_hash", "dry_run", "path", "removed_count", "vault"]);
    expect(d.removed_count).toBe(full.removed_count);
    expect(d.removed_count).toBeGreaterThan(0);
    expect(d.content_hash).toBe(full.content_hash);
  });

  it("prune_hub_links dry run keeps removed[] and prev_hash, the inputs of the confirming call", async () => {
    const d = await call(scenario("prune_hub_links (dry run)"), { response_format: "concise" });
    expect(keys(d)).toEqual([
      "content_hash",
      "dry_run",
      "path",
      "prev_hash",
      "removed",
      "removed_count",
      "vault",
    ]);
  });

  it("list_capture_queue: null and empty fields are omitted, poison_assessment never is", async () => {
    const d = await call(scenario("list_capture_queue"), { response_format: "concise" });
    expect(keys(d)).toEqual(["items", "next_cursor", "vault"]);
    const rows = items(d, "items");
    const suspect = rows.find((r) => String(r.content_preview).startsWith("From now on"));
    const clean = rows.find((r) => r.title === "Clean capture");
    expect(keys(suspect)).toEqual([
      "capture_id",
      "captured_at",
      "content_preview",
      "poison_assessment",
    ]);
    expect(suspect?.poison_assessment).toEqual({ risk: "suspect", signals: ["persistence"] });
    expect(keys(clean)).toEqual([
      "capture_id",
      "captured_at",
      "content_preview",
      "poison_assessment",
      "source",
      "tags",
      "title",
    ]);
    expect(clean?.poison_assessment).toEqual({ risk: "none", signals: [] });
  });

  it("session_bootstrap: loaded[] drops the parsed frontmatter; the note is still whole in content", async () => {
    const full = await call(scenario("session_bootstrap"), {});
    const d = await call(scenario("session_bootstrap"), { response_format: "concise" });
    const loaded = items(d, "loaded");
    expect(loaded.length).toBeGreaterThan(0);
    expect(loaded.length).toBe(items(full, "loaded").length);
    for (const [i, n] of loaded.entries()) {
      expect(keys(n)).toEqual(["content", "content_hash", "path"]);
      expect(n.content).toBe(items(full, "loaded")[i]?.content);
    }
    expect(loaded[0]?.content).toContain("title: Alpha");
    expect(d.truncated).toBe(full.truncated);
    expect(d.skipped).toEqual(full.skipped);
  });

  it("get_entity: a superseded observation keeps valid_to and superseded_by", async () => {
    const { makeM5Vault } = await import("./m5-helpers");
    const v = makeM5Vault({ responseFormat: "concise" });
    try {
      const mk = await v.call(
        "create_entity",
        { vault: "test", type: "probe", name: "P", materialize: false },
        { now: () => 100 },
      );
      const id = String(dataOf(mk).entity_id);
      for (const [text, now] of [
        ["first", 200],
        ["second", 300],
      ] as const)
        await v.call(
          "add_observation",
          { vault: "test", entity_id: id, observation: text, key: "employer" },
          { now: () => now },
        );
      const d = dataOf(await v.call("get_entity", { vault: "test", entity_id: id, as_of: 299 }));
      const obs = items(d, "observations");
      expect(obs).toHaveLength(1);
      expect(keys(obs[0])).toEqual(["key", "superseded_by", "text", "valid_to"]);
      expect(obs[0]?.valid_to).toBe(300);
      expect(typeof obs[0]?.superseded_by).toBe("string");
      // The open observation carries neither field.
      const now = dataOf(await v.call("get_entity", { vault: "test", entity_id: id, as_of: 300 }));
      expect(items(now, "observations").map(keys)).toEqual([["key", "text"]]);
    } finally {
      v.cleanup();
    }
  });

  it("work_episodes: the provenance a reader trusts on (trust, eligibility, session_id, error_code) stays", async () => {
    const d = await call(scenario("work_episodes"), { response_format: "concise" });
    const rows = items(d, "episodes");
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(r.trust).toBe(0.6);
      expect(r.eligibility).toBe("eligible");
      expect(r.session_id).toBe("sess-1");
      for (const dropped of [
        "vault",
        "caller",
        "channel",
        "episode_type",
        "duration_ms",
        "blocked",
      ])
        expect(r, dropped).not.toHaveProperty(dropped);
    }
    expect(rows.find((r) => r.id === "ep-2")?.error_code).toBe("note_not_found");
    expect(rows.find((r) => r.id === "ep-3")?.prev_id).toBe("ep-2");
  });

  it("gap_report: every item keeps its verdict (gap) and top_score", async () => {
    const full = await call(scenario("gap_report"), {});
    const d = await call(scenario("gap_report"), { response_format: "concise" });
    expect(d.gaps).toBe(full.gaps);
    expect(items(d, "items").map((i) => [i.id, i.gap, i.top_score])).toEqual(
      items(full, "items").map((i) => [i.id, i.gap, i.top_score]),
    );
  });
});

describe("part 3 safety signals survive concise", () => {
  it("rewrite_link keeps a redacted to_target echo (the one echo that differs from what was sent)", async () => {
    const { makeTestVault } = await import("./m1-helpers");
    // Assembled at runtime so no literal in source matches a secret pattern.
    const secret = ["gh", "p_", "M1n2B3v4C5x6Z7a8S9d0F1g2H3j4K5l6"].join("");
    const v = makeTestVault({
      files: { "b.md": "# B\n", "a.md": "see [[b]]\n" },
      memoryDefense: { mode: "redact", pii: false },
    });
    try {
      const input = {
        vault: "test",
        from_target: "b",
        to_target: secret,
        dry_run: true,
        response_format: "concise",
      };
      const d = dataOf(await v.call("rewrite_link", input));
      expect(d.to_target).toBeDefined();
      expect(d.to_target).not.toBe(secret);
      expect(d).not.toHaveProperty("from_target");
      // A clean to_target is not echoed back.
      const clean = dataOf(await v.call("rewrite_link", { ...input, to_target: "c" }));
      expect(clean).not.toHaveProperty("to_target");
    } finally {
      v.cleanup();
    }
  });

  it("list_capture_queue keeps poison_assessment on every item, including a never-scanned null", async () => {
    const w = await world();
    const m5 = await w.domain("m5");
    // Every concise item carries the key, whatever its value.
    const d = dataOf(
      await m5.dispatch("list_capture_queue", { vault: "test", response_format: "concise" }),
    );
    for (const it of items(d, "items")) expect(it).toHaveProperty("poison_assessment");
  });

  it("work_episodes and work_search keep trust and eligibility on every row", async () => {
    for (const [name, field] of [
      ["work_episodes", "episodes"],
      ["work_search", "results"],
    ] as const) {
      const d = await call(scenario(name), { response_format: "concise" });
      expect(items(d, field).length, name).toBeGreaterThan(0);
      for (const r of items(d, field)) {
        expect(r, name).toHaveProperty("trust");
        expect(r, name).toHaveProperty("eligibility");
      }
    }
  });

  it("note_quality_report and read_notes keep their per-item safety fields (part 1, still holding)", async () => {
    const d = await call(scenario("note_quality_report"), { response_format: "concise" });
    const a = items(d, "notes").find((n) => n.path === "a.md");
    expect(a?.flags).toEqual(["stale_edit", "orphan"]);
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

  it("the config default reaches every domain (m1, m2, m3, m5, m7, m8)", async () => {
    for (const s of SCENARIOS) {
      // A volatile scenario cannot be compared across two worlds: ask the configured world both ways.
      const [viaConfig, viaParam] = s.volatile
        ? (await callAll(s, [{}, { response_format: "concise" }], "concise")).map(strip)
        : [
            strip(await call(s, {}, "concise")),
            strip(await call(s, { response_format: "concise" })),
          ];
      expect(viaConfig, s.name).toEqual(viaParam);
    }
  });
});

describe("part 4a concise shapes", () => {
  const rows = (d: Record<string, unknown>, field: string) =>
    (d[field] as Array<Record<string, unknown>>) ?? [];

  it("vault_context: the packed notes and lessons stay, the route, budget and stats blocks and per-chunk provenance go", async () => {
    const s = scenario("vault_context");
    const full = await call(s, {});
    const d = await call(s, { response_format: "concise" });
    expect(keys(d)).toEqual(["contradictions", "lessons", "notes", "syntheses", "vault"]);
    expect(keys(full)).toEqual(
      expect.arrayContaining(["budget", "route", "stats", "query_source"]),
    );
    const notes = rows(d, "notes");
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.map((n) => n.path)).toEqual(rows(full, "notes").map((n) => n.path));
    for (const [i, n] of notes.entries()) {
      const fullChunks = rows(rows(full, "notes")[i] as Record<string, unknown>, "chunks");
      for (const [j, c] of rows(n, "chunks").entries()) {
        expect(keys(c)).toEqual(["chunk_id", "content", "score"]);
        expect(c.chunk_id).toBe(fullChunks[j]?.chunk_id);
        expect(c.content).toBe(fullChunks[j]?.content);
        expect(c.score).toBe(fullChunks[j]?.score);
      }
    }
    expect(JSON.stringify(d).length).toBeLessThan(JSON.stringify(full).length);
  });

  it("vault_context: a concise call never poisons the bootstrap prewarm cache, and a cache hit keeps its staleness markers", async () => {
    const dir = makeTempDir("obtc-rf-prewarm-");
    const v = makeM2Vault({
      files: {
        "a.md": "# Alpha\n\nfoxes live here\n",
        "b.md": "# Beta\n\nbeta body about foxes\n",
        "memory/_next-session.md": "# Next\n\nfoxes and beta\n",
      },
    });
    try {
      await v.call("index_vault", { vault: "test" });
      registerM7Tools(v.registry, {
        vaultRegistry: v.vaultRegistry,
        embeddingProvider: v.provider,
        reranker: null,
        roles: null,
        prewarmDir: dir,
      });
      // The first call composes live and writes the cache; the next two are cache hits.
      const live = dataOf(
        await v.call("vault_context", { vault: "test", response_format: "concise" }),
      );
      const hitConcise = dataOf(
        await v.call("vault_context", { vault: "test", response_format: "concise" }),
      );
      const hitDetailed = dataOf(await v.call("vault_context", { vault: "test" }));
      expect(keys(live)).toEqual(["contradictions", "lessons", "notes", "syntheses", "vault"]);
      expect(live.prefetched).toBeUndefined();
      expect(hitConcise.prefetched).toBe(true);
      expect(typeof hitConcise.prefetch_generated_at).toBe("number");
      expect(keys(hitConcise)).not.toContain("route");
      expect(hitDetailed.prefetched).toBe(true);
      expect(hitDetailed.query_source).toBe("next_session");
      expect(keys(hitDetailed)).toEqual(
        expect.arrayContaining(["budget", "route", "signal", "signal_hash", "stats"]),
      );
      const firstNote = rows(hitDetailed, "notes")[0] as Record<string, unknown>;
      expect(rows(firstNote, "chunks")[0]).toHaveProperty("source");
    } finally {
      v.cleanup();
      rmTemp(dir);
    }
  });

  it("explain_answer: each link keeps its verdict, correlation and resolution state; summary and the retrieval echo go; the caveat and the citation-pass record stay", async () => {
    const s = scenario("explain_answer");
    const full = await call(s, {});
    const d = await call(s, { response_format: "concise" });
    expect(keys(full)).toContain("summary");
    expect(keys(d)).toEqual(["available", "caveat", "citation_pass", "links", "scope", "vault"]);
    expect(d.caveat).toBe(full.caveat);
    expect(d.citation_pass).toEqual(full.citation_pass);
    const links = rows(d, "links");
    expect(links.length).toBe(3);
    for (const l of links)
      expect(keys(l)).toEqual([
        "chunk",
        "chunk_id",
        "citation",
        "citation_score",
        "correlation",
        "path",
      ]);
    const gone = links.find((l) => l.chunk_id === "chunk-that-was-rechunked");
    expect(gone).toMatchObject({ chunk: "deleted", path: null });
    expect(links.filter((l) => l.citation === "not_stamped")).toHaveLength(2);
    expect(links.find((l) => l.citation === "confirmed")?.citation_score).toBe(0.9);
    expect(links.map((l) => l.chunk_id)).toEqual(rows(full, "links").map((l) => l.chunk_id));
  });

  it("explain_answer: the unavailable arm is untouched", async () => {
    const w = await world();
    const dom = await w.domain("m7");
    const r = dataOf(
      await dom.dispatch("explain_answer", {
        vault: "test",
        session_id: "s1",
        response_format: "concise",
      }),
    );
    expect(r).toEqual({
      available: false,
      message:
        "experiential store is not open (enable experiential.logRetrievals or captureEpisodes)",
    });
  });

  it("diagnose_retrieval: the answer stays, the stage trace and the echo go, and a readable and an unreadable path look alike", async () => {
    const s = scenario("diagnose_retrieval");
    const full = await call(s, {});
    const d = await call(s, { response_format: "concise" });
    expect(keys(d)).toEqual(["dropped_at", "returned", "summary", "vault"]);
    expect(d.returned).toBe(full.returned);
    expect(d.dropped_at).toBe(full.dropped_at);
    expect(d.summary).toBe(full.summary);
    expect(rows(full, "stages").length).toBeGreaterThan(0);
    const never = await call(s, { path: "no-such-note.md", response_format: "concise" });
    expect(keys(never)).toEqual(keys(d));
  });

  it("knowledge_get_critical: {path, title, category, source} per doc; count and the constant severity go", async () => {
    const s = scenario("knowledge_get_critical");
    const full = await call(s, {});
    const d = await call(s, { response_format: "concise" });
    expect(keys(d)).toEqual(["items", "vault"]);
    expect(rows(d, "items")).toEqual([
      {
        path: "context7/resolve.md",
        title: "Resolve the library id first",
        category: "breaking_change",
        source: "context7",
      },
    ]);
    expect(full.count).toBe(1);
  });

  it("audit_provenance: coverage and the missing list stay, the field echo, with_provenance and by_folder go", async () => {
    const s = scenario("audit_provenance");
    const full = await call(s, {});
    const d = await call(s, { response_format: "concise" });
    expect(keys(d)).toEqual([
      "confidence_coverage",
      "coverage",
      "missing",
      "missing_provenance",
      "scanned",
      "truncated",
      "vault",
      "verified_coverage",
    ]);
    for (const k of keys(d)) expect(d[k], k).toEqual(full[k]);
    expect((full.missing as string[]).length).toBeGreaterThan(0);
    expect(full.by_folder).toBeDefined();
  });

  it("vault_health_score: the score and its four metrics stay, total_links and the penalty breakdown go", async () => {
    const s = scenario("vault_health_score");
    const full = await call(s, {});
    const d = await call(s, { response_format: "concise" });
    expect(keys(d)).toEqual(["metrics", "score", "total_notes", "vault"]);
    expect(d.score).toBe(full.score);
    expect(d.metrics).toEqual(full.metrics);
    expect(keys(full)).toEqual(expect.arrayContaining(["breakdown", "total_links"]));
  });

  it("suggest_links: {path, score} per suggestion; the score components, the echo and total go", async () => {
    const s = scenario("suggest_links");
    const full = await call(s, {});
    const d = await call(s, { response_format: "concise" });
    expect(keys(d)).toEqual(["suggestions", "vault"]);
    const got = rows(d, "suggestions");
    expect(got.map((r) => r.path)).toEqual(["c.md", "x1.md"]);
    for (const r of got) expect(keys(r)).toEqual(["path", "score"]);
    expect(got).toEqual(rows(full, "suggestions").map(({ path, score }) => ({ path, score })));
    expect(rows(full, "suggestions")[0]).toHaveProperty("co_citation");
  });

  it("suggest_tags: the source and the suggestions stay; the echo, the note's own tags, the sampling record and the hint go", async () => {
    const s = scenario("suggest_tags");
    const full = await call(s, {});
    const d = await call(s, { response_format: "concise" });
    expect(keys(d)).toEqual(["source", "suggestions", "vault"]);
    expect(d.source).toBe(full.source);
    expect(d.suggestions).toEqual(full.suggestions);
    expect(keys(full)).toEqual(expect.arrayContaining(["hint", "note_tags", "path", "sampling"]));
  });

  it("bundle_files: the bundle text, the flags and missing_paths stay; the file list and total_bytes go", async () => {
    const s = scenario("bundle_files");
    const full = await call(s, {});
    const d = await call(s, { response_format: "concise" });
    expect(keys(d)).toEqual(["bundle", "file_count", "missing_paths", "truncated", "vault"]);
    expect(d.bundle).toBe(full.bundle);
    expect(d.missing_paths).toEqual(["nope.md"]);
    expect(d.file_count).toBe(full.file_count);
    expect(keys(full)).toEqual(expect.arrayContaining(["files", "total_bytes"]));
  });

  it("bundle_folder: the resume cursor survives concise, and paging with it still works", async () => {
    const s = scenario("bundle_folder (truncated, cursor)");
    const w = await world();
    const first = dataOf(await runScenario(w, s, { response_format: "concise" }));
    expect(keys(first)).toEqual(["bundle", "cursor", "file_count", "truncated", "vault"]);
    expect(first.truncated).toBe(true);
    expect(typeof first.cursor).toBe("string");
    const fullFirst = dataOf(await runScenario(w, s, {}));
    expect(first.cursor).toBe(fullFirst.cursor);
    expect(first.bundle).toBe(fullFirst.bundle);
    const next = dataOf(
      await runScenario(w, s, { response_format: "concise", cursor: first.cursor }),
    );
    expect(String(next.bundle)).not.toBe(String(first.bundle));
    expect(next.file_count).toBe(1);
  });

  it("read_canvas: what a node says and what an edge joins stay; geometry, background, edge sides and ends and the counts go", async () => {
    const s = scenario("read_canvas");
    const full = await call(s, {});
    const d = await call(s, { response_format: "concise" });
    expect(keys(d)).toEqual(["content_hash", "edges", "nodes", "path", "vault"]);
    expect(d.content_hash).toBe(full.content_hash);
    expect(rows(d, "nodes").map(keys)).toEqual([
      ["color", "id", "text", "type"],
      ["file", "id", "type"],
    ]);
    expect(rows(d, "edges").map(keys)).toEqual([["fromNode", "id", "label", "toNode"]]);
    expect(keys(full)).toEqual(expect.arrayContaining(["edge_count", "node_count"]));
    expect(keys(rows(full, "nodes")[0] as Record<string, unknown>)).toEqual(
      expect.arrayContaining(["height", "width", "x", "y"]),
    );
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
      const def = (await registryOf(w, s)).list().find((t) => t.name === s.tool);
      expect(def, s.tool).toBeDefined();
      const props = Object.keys(topLevelShape(def?.inputSchema) ?? {});
      expect(props, s.tool).toContain("response_format");
      expect(props, s.tool).toContain("verbosity");
    }
  });
});
