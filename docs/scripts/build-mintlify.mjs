// Assemble the Mintlify site from the docs sources.
//
//   node scripts/build-mintlify.mjs [--out dist]
//
// Mintlify builds straight from a git tree with no build step of its own, while this repo
// commits none of its generated docs (per-tool pages, the decisions index, filled docgen
// regions). So `bun run gen` writes those into src/content/docs, and this script copies the
// finished tree into one self-contained folder that Mintlify can serve as-is:
//
//   - src/content/docs/**  -> <out>/            (pages and docs.json)
//   - public/**            -> <out>/            (images and favicon; CNAME is GitHub Pages only)
//   - the "Per-tool pages" group in docs.json is filled from tools/reference/*.md, so a new
//     tool needs no hand edit to appear in the navigation.
//
// CI runs this, checks the result with `mint validate` and `mint broken-links`, and on main
// publishes <out> to the docs-site branch, which the Mintlify hub repository pulls in.
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const docsRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const outArg = args.indexOf("--out");
const out = join(docsRoot, outArg === -1 ? "dist" : args[outArg + 1]);
const src = join(docsRoot, "src/content/docs");
const pub = join(docsRoot, "public");
const TOOL_GROUP = "Per-tool pages";
const TOOL_DIR = "tools/reference";

const fail = (msg) => {
  process.stderr.write(`build-mintlify: ${msg}\n`);
  process.exit(1);
};

const toolDir = join(src, TOOL_DIR);
if (!existsSync(toolDir)) fail(`${TOOL_DIR} is missing; run \`bun run gen\` first`);

rmSync(out, { recursive: true, force: true });
cpSync(src, out, { recursive: true });
cpSync(pub, out, {
  recursive: true,
  filter: (from) => !from.endsWith("CNAME"),
});

const toolPages = readdirSync(toolDir)
  .filter((f) => f.endsWith(".md"))
  .map((f) => `${TOOL_DIR}/${f.slice(0, -3)}`)
  .sort();
if (toolPages.length === 0) fail(`${TOOL_DIR} has no pages; run \`bun run gen\` first`);

const configPath = join(out, "docs.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));

// Depth-first search for the one group named TOOL_GROUP; it must exist exactly once.
const found = [];
const walk = (node) => {
  if (Array.isArray(node)) return node.forEach(walk);
  if (node === null || typeof node !== "object") return;
  if (node.group === TOOL_GROUP) found.push(node);
  for (const v of Object.values(node)) walk(v);
};
walk(config.navigation);
if (found.length !== 1) fail(`docs.json must have exactly one "${TOOL_GROUP}" group, found ${found.length}`);
found[0].pages = toolPages;

writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

// Mintlify parses .md as MDX, and these pages are plain Markdown that also has to suit the
// docgen tooling and GitHub. Make the copies MDX-safe without touching the sources:
//   - `{` and `}` in prose would start a JS expression, so escape them (tool descriptions quote
//     JSON). Lines that are component tags (`<Columns cols={2}>`) are left alone.
//   - `[[target]]` in prose is Obsidian syntax being described, not a link: show it as code.
//   - HTML comments are not valid MDX; the docgen region markers must stay HTML comments in the
//     sources, so rewrite them as MDX comments here.
// Fenced code blocks and inline code spans are never changed.
const COMPONENT_LINE = /^\s*<\/?[A-Z][\w.]*(\s|>|\/>|$)/;
// A `<` in prose is a tag only when it opens a Mintlify component, an HTML comment, an autolink
// or one of a few inline HTML tags; anything else (`Promise<T>`, `<=`, `<cacheDir>`) is text.
const REAL_TAG =
  /^<(?:!--|\/?(?:Note|Tip|Warning|Danger|Info|Check|Card|Columns|Steps|Step|Tabs|Tab|Accordion|AccordionGroup|CodeGroup|Frame)\b|https?:\/\/|\/?(?:br|kbd|sup|sub|details|summary)\b)/;
const proseSafe = (segment) =>
  segment
    .replace(/[{}]/g, (c) => `\\${c}`)
    .replace(/\[\[([^\]\n]+)\]\]/g, "`[[$1]]`")
    .replace(/</g, (c, i, s) => (REAL_TAG.test(s.slice(i)) ? c : "&lt;"));

// Heading IDs: Starlight slugged headings with github-slugger, and Mintlify slugs them its own way,
// so `#remote-key-set-authjwksuri`-style links (in these pages and from outside, to the old site)
// would stop resolving. Pin every heading to the github-slugger ID with Mintlify's `{#id}` syntax.
// The text is only ever slugged (githubSlug drops every `<` and `>`), never emitted as HTML; tags are
// stripped to a fixed point so a nested `<<b>b>` cannot leave a tag-shaped remainder behind.
const stripTags = (s) => {
  let prev;
  let out = s;
  do {
    prev = out;
    out = out.replace(/<[^<>]*>/g, "");
  } while (out !== prev);
  return out.replace(/[<>]/g, "");
};
const headingText = (raw) =>
  stripTags(raw.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*_~]/g, "")); // links -> text
const githubSlug = (text) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "")
    .replace(/ /g, "-");

function mdxSafe(text) {
  const fm = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  const head = fm ? fm[0] : "";
  const seen = new Map();
  const uniqueSlug = (base) => {
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  };
  let fence = null;
  const lines = text
    .slice(head.length)
    .split("\n")
    .map((line) => {
      const f = line.match(/^\s*(`{3,}|~{3,})/);
      if (f) {
        if (fence === null) fence = f[1];
        else if (line.trim().startsWith(fence)) fence = null;
        return line;
      }
      if (fence !== null || COMPONENT_LINE.test(line)) return line;
      // Odd-indexed parts are inline code spans (matched by equal-length backtick runs).
      const safe = (s) =>
        s
          .split(/(`+[^`]*?`+)/)
          .map((part, i) => (i % 2 === 1 ? part : proseSafe(part)))
          .join("");
      const h = line.match(/^(#{1,6})\s+(.+?)\s*$/);
      if (h && !/\{#[\w-]+\}$/.test(h[2])) {
        const slug = uniqueSlug(githubSlug(headingText(h[2])));
        return slug ? `${h[1]} ${safe(h[2])} {#${slug}}` : `${h[1]} ${safe(h[2])}`;
      }
      return safe(line);
    });
  const body = lines.join("\n").replace(/<!--([\s\S]*?)-->/g, (_, c) => `{/*${c.replace(/\*\//g, "* /")}*/}`);
  return head + body;
}

const walkFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walkFiles(join(dir, e.name)) : [join(dir, e.name)],
  );
let rewritten = 0;
for (const file of walkFiles(out).filter((f) => f.endsWith(".md") || f.endsWith(".mdx"))) {
  const before = readFileSync(file, "utf8");
  const after = mdxSafe(before);
  if (after !== before) {
    writeFileSync(file, after);
    rewritten++;
  }
}

process.stderr.write(
  `build-mintlify: assembled ${out} with ${toolPages.length} tool pages (${rewritten} pages made MDX-safe)\n`,
);
