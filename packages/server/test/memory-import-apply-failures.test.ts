// THE-1124 — review finding: apply.ts used to discard the results of `add_observation` and
// `update_frontmatter`, reporting success with 0 errors even when a write genuinely failed. These
// tests inject a failure into a real dispatch (wrapping the real harness, not a fake one — every
// OTHER call still goes through the real M1/M5 tools) and assert it surfaces as an "error" outcome
// instead of being silently swallowed.
import { fileURLToPath } from "node:url";
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import type { Dispatch } from "../src/memory-import/apply";
import { applyImport } from "../src/memory-import/apply";
import { buildParsedSource } from "../src/memory-import/plan";
import { makeMemoryImportHarness } from "./memory-import-helpers";

const FIXTURE_ROOT = fileURLToPath(new URL("fixtures/memory-import/basic-memory", import.meta.url));

/** Wrap a real dispatch so the Nth call to `toolName` returns a synthetic failure instead of
 *  reaching the real tool — every other call (including earlier/later calls to the SAME tool
 *  name) passes through unchanged. */
function failingOnCall(dispatch: Dispatch, toolName: string, failOnCallIndex: number): Dispatch {
  let calls = 0;
  return async (name, input) => {
    if (name === toolName) {
      const thisCall = calls++;
      if (thisCall === failOnCallIndex) {
        const failure: ToolResult = {
          ok: false,
          error: { code: "internal_error", message: "injected failure for test", retryable: false },
          meta: { duration_ms: 0, result_size: 0 },
        };
        return failure;
      }
    }
    return dispatch(name, input);
  };
}

describe("apply.ts — dispatch failures are never discarded", () => {
  it("a failed update_frontmatter at create time is an error outcome, not a silent success", async () => {
    const h = makeMemoryImportHarness();
    try {
      const parsed = buildParsedSource(FIXTURE_ROOT, "basic-memory");
      const dispatch = failingOnCall(h.dispatch, "update_frontmatter", 0);
      const report = await applyImport(parsed, {
        vault: "test",
        adapter: "basic-memory",
        dispatch,
        applied: true,
        now: () => "2026-01-01T00:00:00.000Z",
      });
      const coffee = report.entities.find((e) => e.name === "Coffee Brewing Methods");
      expect(coffee?.action).toBe("error");
      expect(coffee?.reason).toContain("provenance frontmatter could not be set");
      expect(coffee?.reason).toContain("injected failure for test");
      // The entity row and its note DO exist (create_entity itself succeeded) — this is a
      // real, resumable state, not a rollback; --resume is how it gets fixed next run.
      const get = await h.dispatch("get_entity", {
        vault: "test",
        type: "note",
        name: "Coffee Brewing Methods",
      });
      expect(get.ok).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it("a failed add_observation on an EXISTING entity stops that entity and is reported as an error", async () => {
    const h = makeMemoryImportHarness();
    try {
      const parsed = buildParsedSource(FIXTURE_ROOT, "basic-memory");
      // First run: real, succeeds — Coffee Brewing Methods now exists with its 2 observations
      // and correct source_path provenance.
      const first = await applyImport(parsed, {
        vault: "test",
        adapter: "basic-memory",
        dispatch: h.dispatch,
        applied: true,
        now: () => "2026-01-01T00:00:00.000Z",
      });
      expect(first.entities.every((e) => e.action === "create")).toBe(true);

      // Second run: a synthetic parse result for the SAME entity with one NEW observation added
      // (a hand-built ParsedSource, not a second fixture directory — the point is purely "there
      // is something new to add", not another real basic-memory file), and add_observation made
      // to fail on its first call.
      const parsed2 = {
        entities: [
          {
            sourcePath: "notes/coffee-brewing.md",
            entityType: "note",
            name: "Coffee Brewing Methods",
            observations: [
              "[method] Pour over provides more flavor clarity than French press",
              "[technique] Water temperature at 205F extracts optimal compounds #brewing",
              "[new] a second-run observation that must be added",
            ],
            relations: [],
          },
        ],
        skipped: [],
      };
      const dispatch = failingOnCall(h.dispatch, "add_observation", 0);
      const second = await applyImport(parsed2, {
        vault: "test",
        adapter: "basic-memory",
        dispatch,
        applied: true,
        now: () => "2026-01-02T00:00:00.000Z",
      });
      const coffee = second.entities.find((e) => e.name === "Coffee Brewing Methods");
      expect(coffee?.action).toBe("error");
      expect(coffee?.reason).toContain("add_observation failed after 0/1");
      // The observation was never added — the note still shows exactly 2, not 3.
      const note = h.read("memory/note/Coffee Brewing Methods.md");
      expect(note).not.toContain("a second-run observation");
    } finally {
      h.cleanup();
    }
  });

  it("an entity outcome of error excludes it from the relation phase (it cannot be a valid source or target)", async () => {
    const h = makeMemoryImportHarness();
    try {
      const parsed = {
        entities: [
          {
            sourcePath: "a.md",
            entityType: "note",
            name: "A",
            observations: [],
            relations: [{ relationType: "relates_to", targetName: "B" }],
          },
          { sourcePath: "b.md", entityType: "note", name: "B", observations: [], relations: [] },
        ],
        skipped: [],
      };
      const dispatch = failingOnCall(h.dispatch, "update_frontmatter", 0);
      const report = await applyImport(parsed, {
        vault: "test",
        adapter: "basic-memory",
        dispatch,
        applied: true,
        now: () => "2026-01-01T00:00:00.000Z",
      });
      const a = report.entities.find((e) => e.name === "A");
      expect(a?.action).toBe("error");
      expect(a?.relations).toStrictEqual([]); // never attempted — A itself failed
    } finally {
      h.cleanup();
    }
  });
});
