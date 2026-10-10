// Result-size budgets (mcp/result-size.ts): clients cap what they inline from a tool result (Grok
// Build ~20 KB and it drops resource_link; claude.ai ~150k chars; Claude Code 50k chars unless the
// tool's tools/list entry says otherwise). So:
//   1. every list/search tool's DEFAULT call stays under DEFAULT_PAGE_BYTES on a large vault, by
//      lowering item counts (never by cutting a result mid-item) and says how to get the next page;
//   2. paging reaches every item;
//   3. exactly the whole-note readers advertise `anthropic/maxResultSizeChars`;
//   4. nothing hands a client a resource_link / image / embedded blob without a text block.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFullRegistry } from "../scripts/docgen/build-registry";
import {
  CLAUDE_CODE_MAX_RESULT_SIZE_CEILING,
  DEFAULT_PAGE_BYTES,
  MAX_RESULT_SIZE_META_FIELD,
} from "../src/mcp/result-size";
import { toMcpTool } from "../src/mcp/tool-projection";
import { ensureTextContent } from "../src/mcp/tool-result";
import { makeSizeWorld, NOTE_COUNT, type SizeWorld } from "./result-size-world";

const HUB = "hub.md";
const FIRST = "projects/alpha/note-0000-retrieval-pipeline-latency.md";

/** Every list/search-type tool that can be driven on the generated vault with just these args.
 *  The whole-note readers (search_and_read, read_notes, ...) are not here: their pages are cut by
 *  the byte-budget paginator, and they advertise maxResultSizeChars instead. */
const DEFAULT_CALLS: Array<[tool: string, args: Record<string, unknown>]> = [
  ["list_notes", {}],
  ["list_properties", {}],
  ["find_notes_by_property", { key: "status", value: "open" }],
  ["list_tags", {}],
  ["find_notes_by_tag", { tag: "project" }],
  ["get_backlinks", { path: HUB }],
  ["get_outgoing_links", { path: FIRST }],
  ["find_orphans", {}],
  ["find_unresolved_links", {}],
  ["graph_centrality", {}],
  ["graph_communities", {}],
  ["find_link_cycles", {}],
  ["suggest_links", { path: FIRST }],
  ["audit_provenance", {}],
  ["list_snapshots", { path: FIRST }],
  ["search_text", { query: "decision" }],
  ["search_regex", { pattern: "decision" }],
  ["search_semantic", { query: "decision follow-up" }],
  ["search_vault", { query: "decision" }],
  ["search", { query: "decision" }],
  ["list_periodic_notes", { period: "daily" }],
  ["list_attachments", {}],
  ["list_tasks", {}],
  ["vault_graph_search", { query: "decision" }],
  ["vault_context", { query: "decision" }],
  ["reflect", { query: "decision" }],
];

/** The whole-note readers: the ONLY tools that advertise the Claude Code result-size annotation. */
const WHOLE_NOTE_READERS = [
  "bundle_files",
  "bundle_folder",
  "fetch",
  "get_active_file",
  "read_note",
  "read_notes",
  "read_resources",
  "read_snapshot",
  "search_and_read",
  "session_bootstrap",
];

describe("default pages stay under the inline limit", { timeout: 60_000 }, () => {
  let w: SizeWorld;
  beforeAll(async () => {
    w = await makeSizeWorld();
  }, 120_000);
  afterAll(() => w?.cleanup());

  const call = async (tool: string, args: Record<string, unknown>) => {
    const r = await w.vault.call(tool, { vault: "test", ...args });
    if (!r.ok) throw new Error(`${tool}: ${JSON.stringify(r.error)}`);
    return r.data as Record<string, unknown>;
  };

  it("the fixture is big enough to exercise paging (existence floor)", () => {
    expect(NOTE_COUNT).toBeGreaterThanOrEqual(500);
    expect(w.notePaths).toHaveLength(NOTE_COUNT);
  });

  for (const [tool, args] of DEFAULT_CALLS) {
    it(`${tool}: a default call is <= ${DEFAULT_PAGE_BYTES} bytes`, async () => {
      const data = await call(tool, args);
      expect(JSON.stringify(data).length).toBeLessThanOrEqual(DEFAULT_PAGE_BYTES);
    });
  }

  it("checks at least 25 list/search tools (existence floor)", () => {
    expect(DEFAULT_CALLS.length).toBeGreaterThanOrEqual(25);
    expect(new Set(DEFAULT_CALLS.map(([t]) => t)).size).toBe(DEFAULT_CALLS.length);
  });

  /** Walk `tool` page by page; `pick` extracts the items of a page. */
  async function walk(
    tool: string,
    args: Record<string, unknown>,
    pick: (d: Record<string, unknown>) => unknown[],
  ): Promise<{ items: unknown[]; pages: number; firstPageSize: number }> {
    const items: unknown[] = [];
    let cursor: string | null | undefined;
    let pages = 0;
    let firstPageSize = 0;
    do {
      const data = await call(tool, { ...args, ...(cursor ? { cursor } : {}) });
      if (pages === 0) firstPageSize = JSON.stringify(data).length;
      items.push(...pick(data));
      cursor = (data.next_cursor as string | null | undefined) ?? null;
      pages++;
      expect(pages).toBeLessThan(200);
    } while (cursor);
    return { items, pages, firstPageSize };
  }

  const paths =
    (key: string, field = "path") =>
    (d: Record<string, unknown>) =>
      (d[key] as Array<Record<string, unknown>>).map((x) => String(x[field]));

  it("list_notes: paging reaches every note exactly once", async () => {
    const { items, pages } = await walk("list_notes", {}, paths("notes"));
    expect(pages).toBeGreaterThan(1);
    expect(new Set(items).size).toBe(items.length);
    expect(items).toHaveLength(NOTE_COUNT + 1); // the generated notes plus hub.md
  });

  it("list_attachments: paging reaches every attachment exactly once", async () => {
    const { items, pages } = await walk("list_attachments", {}, paths("attachments"));
    expect(pages).toBeGreaterThan(1);
    expect(new Set(items).size).toBe(items.length);
    expect(items).toHaveLength(340);
  });

  it("get_backlinks: paging reaches every backlink and each page is under the budget", async () => {
    const { items, pages, firstPageSize } = await walk(
      "get_backlinks",
      { path: HUB },
      paths("backlinks", "source_path"),
    );
    expect(pages).toBeGreaterThan(1);
    expect(firstPageSize).toBeLessThanOrEqual(DEFAULT_PAGE_BYTES);
    expect(new Set(items).size).toBe(NOTE_COUNT);
  });

  it("find_unresolved_links: paging reaches every dangling link", async () => {
    const { items, pages, firstPageSize } = await walk("find_unresolved_links", {}, (d) =>
      (d.unresolved as Array<Record<string, unknown>>).map((x) => `${x.source_path}|${x.target}`),
    );
    expect(pages).toBeGreaterThan(1);
    expect(firstPageSize).toBeLessThanOrEqual(DEFAULT_PAGE_BYTES);
    expect(new Set(items).size).toBe(items.length);
    expect(items).toHaveLength(NOTE_COUNT * 3);
  });

  it("find_notes_by_tag / find_notes_by_property: paging reaches every match", async () => {
    const byTag = await walk("find_notes_by_tag", { tag: "project" }, paths("matches"));
    const direct = await call("find_notes_by_tag", { tag: "project", limit: 1000 });
    expect(byTag.items).toHaveLength((direct.matches as unknown[]).length);
    expect(byTag.pages).toBeGreaterThan(1);
    const byProp = await walk(
      "find_notes_by_property",
      { key: "status", value: "open" },
      paths("matches"),
    );
    expect(byProp.items).toHaveLength(NOTE_COUNT / 3);
    expect(byProp.pages).toBeGreaterThan(1);
  });

  it("find_orphans: pages reach every orphan", async () => {
    const all = await call("find_orphans", { limit: 5000 });
    const { items } = await walk("find_orphans", { limit: 2 }, paths("orphans", "path"));
    expect(items).toHaveLength((all.orphans as unknown[]).length);
  });

  it("search_text: paging reaches every hit and each page says how to continue", async () => {
    const first = await call("search_text", { query: "decision" });
    expect(typeof first.next_cursor).toBe("string");
    // Each page rescans the vault, so walk with bigger pages: the default page is checked above,
    // and 600 notes at the default page size timed out on a Windows runner.
    const { items, pages } = await walk("search_text", { query: "decision", limit: 200 }, (d) =>
      (d.items as Array<Record<string, unknown>>).map((x) => String(x.path)),
    );
    expect(pages).toBeGreaterThan(1);
    expect(new Set(items).size).toBe(NOTE_COUNT);
  }, 180_000);

  it("find_link_cycles: bounded cycle length, and it reports what it skipped", async () => {
    const data = await call("find_link_cycles", {});
    const cycles = data.cycles as string[][];
    expect(cycles.length).toBeGreaterThan(0);
    for (const c of cycles) expect(c.length - 1).toBeLessThanOrEqual(10);
    expect(typeof data.skipped_longer).toBe("number");
  });
});

describe("maxResultSizeChars is advertised on the whole-note readers only", () => {
  const defs = buildFullRegistry().list();

  it("reads the right tools (existence floor: the registry is the full surface)", () => {
    expect(defs.length).toBeGreaterThan(100);
    expect(
      defs
        .filter((d) => d.wholeNotes)
        .map((d) => d.name)
        .sort(),
    ).toEqual(WHOLE_NOTE_READERS);
  });

  it("tools/list projection carries the key on those tools and on no other", () => {
    const withKey = defs
      .filter((d) => toMcpTool(d, 1_000_000)._meta?.[MAX_RESULT_SIZE_META_FIELD] !== undefined)
      .map((d) => d.name)
      .sort();
    expect(withKey).toEqual(WHOLE_NOTE_READERS);
  });

  it("the key is the governor ceiling, capped at Claude Code's own 500,000", () => {
    const read = defs.find((d) => d.name === "read_note");
    if (!read) throw new Error("read_note missing");
    expect(MAX_RESULT_SIZE_META_FIELD).toBe("anthropic/maxResultSizeChars");
    expect(toMcpTool(read, 1_000_000)._meta?.[MAX_RESULT_SIZE_META_FIELD]).toBe(
      CLAUDE_CODE_MAX_RESULT_SIZE_CEILING,
    );
    expect(toMcpTool(read, 200_000)._meta?.[MAX_RESULT_SIZE_META_FIELD]).toBe(200_000);
    // No budget given (a bare projection): no claim at all.
    expect(toMcpTool(read)._meta).toBeUndefined();
  });
});

describe("no tool result hands a client only a link or a blob", () => {
  it("a resource_link / image result with no text block gets a text block, blocks kept", () => {
    const link = {
      type: "resource_link",
      uri: "obsidian-tc://vault/a.md",
      name: "a.md",
    } as const;
    const image = { type: "image", data: "AAAA", mimeType: "image/png" } as const;
    const out = ensureTextContent({
      content: [link, image],
      structuredContent: { path: "a.md", mime: "image/png" },
    } as CallToolResult);
    expect(out.content[0]?.type).toBe("text");
    expect(out.content).toContainEqual(link);
    expect(out.content).toContainEqual(image);
  });

  it("source never builds a resource_link / image / embedded-resource block (existence floor)", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(join(import.meta.dirname, "..", "src"));
    expect(files.length).toBeGreaterThan(300);
    const offenders = files.filter((f) =>
      /type:\s*["'](resource_link|image|resource|audio)["']/.test(readFileSync(f, "utf8")),
    );
    // A new block type must come with a text sibling (ensureTextContent guarantees one) AND an
    // entry here saying so.
    expect(offenders).toEqual([]);
  });
});
