// docgen — invariant check for the generated per-tool pages: the pages, the live registry and the
// committed catalog must agree. Pure over its inputs (tool-pages.ts feeds it the real ones) so the
// failure shapes are unit-testable.
//
// Same discipline as scripts/check-config-threading.mjs: both directions (a tool without a page, a
// page without a tool), a floor so a broken scan cannot report a clean result, and a canary that
// must be present for the scan to count as armed.
import type { ToolDoc } from "./model";
import { renderToolPage } from "./render-tool-pages";
import { TOOL_PAGES_URL_BASE, toolPageSlug } from "./tool-page-slug";

/** A registry this small means extraction broke, not that the surface shrank. */
export const MIN_TOOLS = 100;
/** Tools that must always have a page; if they do not, the scan is not looking at the real surface. */
const CANARIES = ["read_note", "write_note"];

export interface ToolPagesInput {
  tools: ToolDoc[];
  /** File names (`<slug>.md`) found in the generated pages directory. */
  files: string[];
  /** File name -> content, to catch a page left over from an older registry. */
  contents: Map<string, string>;
  /** The committed catalog markdown (the docs-site copy, with page links). */
  catalog: string;
  /** Page directories found in the built site (`<slug>`), when a build has run. */
  dist?: string[];
}

const ROW_RE = /^\| (\[)?`([a-z0-9_-]+)`(?:\]\(([^)]*)\))? \|/;

export function checkToolPages(input: ToolPagesInput): string[] {
  const { tools, files, contents, catalog, dist } = input;
  const problems: string[] = [];

  if (tools.length < MIN_TOOLS) {
    problems.push(
      `registry floor: enumerated ${tools.length} tools (< ${MIN_TOOLS}) — the extractor is broken, not the docs`,
    );
    return problems;
  }

  const wantFiles = new Set(tools.map((t) => `${toolPageSlug(t.name)}.md`));
  const haveFiles = new Set(files);
  if (haveFiles.size !== wantFiles.size) {
    problems.push(`page count ${haveFiles.size} != registry tool count ${wantFiles.size}`);
  }
  for (const f of wantFiles) if (!haveFiles.has(f)) problems.push(`missing page ${f}`);
  for (const f of haveFiles)
    if (!wantFiles.has(f)) problems.push(`orphan page ${f} (no such tool)`);
  for (const c of CANARIES) {
    if (!haveFiles.has(`${c}.md`))
      problems.push(`canary ${c}.md has no page — the scan is not armed`);
  }

  for (const t of tools) {
    const f = `${toolPageSlug(t.name)}.md`;
    const have = contents.get(f);
    if (have !== undefined && have !== renderToolPage(t, tools)) {
      problems.push(`stale page ${f} — regenerate with \`bun run gen:tool-pages\` in docs/`);
    }
  }

  const rows = catalog.split("\n").filter((l) => ROW_RE.test(l));
  if (rows.length === 0) {
    problems.push("no catalog rows found — the catalog parser or the catalog is broken");
  }
  const linked = new Set<string>();
  for (const line of rows) {
    const m = ROW_RE.exec(line);
    if (!m) continue;
    const name = m[2] ?? "";
    const href = m[3];
    if (href === undefined) {
      problems.push(`catalog row \`${name}\` has no link to its page`);
      continue;
    }
    if (href !== `${TOOL_PAGES_URL_BASE}${name}/` || !haveFiles.has(`${name}.md`)) {
      problems.push(`catalog row \`${name}\` links to ${href}, which is not an existing page`);
    }
    linked.add(name);
  }
  for (const t of tools) {
    if (!linked.has(t.name)) problems.push(`tool ${t.name} has no catalog row`);
  }

  if (dist !== undefined && dist.length !== wantFiles.size) {
    problems.push(`built site has ${dist.length} tool pages, registry has ${wantFiles.size}`);
  }
  return problems;
}
