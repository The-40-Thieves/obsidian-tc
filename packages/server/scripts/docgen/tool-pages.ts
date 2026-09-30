// docgen — per-tool page generator + checker CLI.
//
//   bun scripts/docgen/tool-pages.ts                    write one page per registered tool
//   bun scripts/docgen/tool-pages.ts --check            verify pages + registry + catalog agree
//   bun scripts/docgen/tool-pages.ts --check --dist D   also count the pages in the built site D
//
// The pages are build output: `docs/package.json` runs this before `astro build`, into a
// gitignored directory. The combined catalog is a generated region filled at build time too (the
// committed region is canonical-empty), so --check renders the catalog IN MEMORY from the registry
// rather than reading a file that only exists after `docgen:render`.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkToolPages } from "./check-tool-pages";
import { extractTools } from "./extract-tools";
import { renderToolPage } from "./render-tool-pages";
import { renderTools } from "./render-tools";
import { TOOL_PAGES_DIR, TOOL_PAGES_URL_BASE, toolPageSlug } from "./tool-page-slug";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/$/, "");
const pagesDir = `${repoRoot}/${TOOL_PAGES_DIR}`;
const args = process.argv.slice(2);
const distArg = args.indexOf("--dist");
const dist = distArg === -1 ? undefined : args[distArg + 1];

const tools = extractTools();

if (!args.includes("--check")) {
  rmSync(pagesDir, { recursive: true, force: true });
  mkdirSync(pagesDir, { recursive: true });
  for (const t of tools)
    writeFileSync(`${pagesDir}/${toolPageSlug(t.name)}.md`, renderToolPage(t, tools));
  process.stderr.write(`docgen: wrote ${tools.length} tool pages to ${TOOL_PAGES_DIR}\n`);
  process.exit(0);
}

if (!existsSync(pagesDir)) {
  process.stderr.write(
    `tool-pages: ${TOOL_PAGES_DIR} does not exist — run the docs build (or without --check) first\n`,
  );
  process.exit(1);
}
const files = readdirSync(pagesDir).filter((f) => f.endsWith(".md"));
const contents = new Map(files.map((f) => [f, readFileSync(`${pagesDir}/${f}`, "utf8")]));
let distPages: string[] | undefined;
if (dist !== undefined) {
  const root = `${dist}/tools/reference`;
  if (!existsSync(root)) {
    process.stderr.write(`tool-pages: built site has no ${root} — did the build run?\n`);
    process.exit(1);
  }
  distPages = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

const problems = checkToolPages({
  tools,
  files,
  contents,
  catalog: renderTools(tools, TOOL_PAGES_URL_BASE),
  ...(distPages ? { dist: distPages } : {}),
});
if (problems.length > 0) {
  process.stderr.write(`tool-pages: ${problems.length} problem(s)\n`);
  for (const p of problems) process.stderr.write(`  ${p}\n`);
  process.exit(1);
}
process.stdout.write(
  `tool-pages: clean (${tools.length} registry tools, ${files.length} pages, ${tools.length} catalog links${distPages ? `, ${distPages.length} built pages` : ""})\n`,
);
