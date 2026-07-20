// docgen — LLM-assisted narrative sync (THE-477). ADVISORY ONLY. Given what changed in the generated
// reference (the compact, factual signal), ask a model whether the hand-authored PROSE in README /
// ARCHITECTURE needs updating, and PRINT the suggestion for a human to review and apply. It never
// writes a file, never commits, never opens a PR — generation (extractors/renderers) is trustworthy
// because it's derived; prose is invented, so it stays human-gated.
//
// Runs locally / on a tailnet-connected runner (the LiteLLM gateway is not reachable from cloud CI).
// Configure via env; with no LLM configured it prints the assembled prompt (dry-run) so it is useful
// and testable without a gateway:
//   DOCGEN_LLM_URL   OpenAI-compatible base, e.g. http://host:4001/v1
//   DOCGEN_LLM_KEY   bearer token
//   DOCGEN_LLM_MODEL e.g. groq/llama-3.3-70b-versatile
//
//   bun scripts/docgen/suggest-prose.ts [--range <git-range>] [--docs README.md,ARCHITECTURE.md]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/** Markdown-only: the tool assembles hand-authored PROSE, which lives in .md/.mdx. */
const ALLOWED_DOC_EXT = new Set([".md", ".mdx"]);

/**
 * THE-477 hardening (audit #9): resolve a `--docs` entry to an absolute path that is CONTAINED in
 * REPO_ROOT, is a markdown file, and has no hidden path segment — else null (the caller skips + warns).
 * Without this, `--docs ../../secret` concatenated straight onto REPO_ROOT read an out-of-repo file
 * and shipped its content to the configured LLM endpoint. Pure (path math only); the caller
 * additionally realpath-verifies containment to defeat a symlink that points outside the repo.
 */
export function resolveDocPath(repoRoot: string, entry: string): string | null {
  const p = entry.trim();
  if (p === "" || isAbsolute(p)) return null;
  if (!ALLOWED_DOC_EXT.has(extname(p).toLowerCase())) return null;
  const abs = resolve(repoRoot, p);
  const rel = relative(repoRoot, abs);
  // rel escapes the root when it is empty, starts with "..", or is itself absolute (different drive).
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  if (rel.split(sep).some((seg) => seg.startsWith("."))) return null; // no hidden segment (.git, .env, …)
  return abs;
}

const SYSTEM =
  "You are a senior technical writer maintaining an open-source project's docs. You are given a diff " +
  "of the AUTO-GENERATED reference (tool/config tables) and the current hand-authored PROSE. Decide " +
  "whether the prose is now stale or incomplete. Be conservative: generated tables already cover the " +
  "facts, so only flag prose that MISCLAIMS or OMITS something a reader needs. Reply with a short " +
  "bulleted list of concrete suggested edits (quote the sentence, propose the replacement), or the " +
  "single line NO CHANGE NEEDED. Never invent capabilities; ground every suggestion in the diff.";

/** Build the (pure) user prompt from the reference diff + the current prose excerpts. Testable. */
export function buildProsePrompt(
  referenceDiff: string,
  docs: ReadonlyArray<{ name: string; content: string }>,
): string {
  const diff = referenceDiff.trim() || "(no reference changes)";
  const proseBlocks = docs.map((d) => `### ${d.name}\n\n${d.content.trim()}`).join("\n\n---\n\n");
  return [
    "## What changed in the generated reference",
    "```diff",
    diff,
    "```",
    "",
    "## Current hand-authored prose",
    proseBlocks,
    "",
    "## Task",
    "List concrete prose edits grounded in the diff, or reply exactly `NO CHANGE NEEDED`.",
  ].join("\n");
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
}

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
  } catch {
    return "";
  }
}

async function callLlm(prompt: string): Promise<string> {
  const url = process.env.DOCGEN_LLM_URL;
  const key = process.env.DOCGEN_LLM_KEY;
  const model = process.env.DOCGEN_LLM_MODEL;
  if (!url || !key || !model) {
    return `[dry-run] Set DOCGEN_LLM_URL / DOCGEN_LLM_KEY / DOCGEN_LLM_MODEL to call the model.\nAssembled prompt below:\n\n${prompt}`;
  }
  const res = await fetch(`${url.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) return `LLM call failed: ${res.status} ${res.statusText}`;
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content ?? "(no suggestion returned)";
}

async function main(): Promise<void> {
  const range = arg("--range", "HEAD~1..HEAD");
  const docPaths = arg("--docs", "README.md,ARCHITECTURE.md").split(",");
  // The compact, factual signal: how the generated reference tables moved in this range.
  const referenceDiff = git([
    "diff",
    range,
    "--",
    "docs/wiki/Tool-Reference.md",
    "docs/wiki/Configuration.md",
    "docs/src/content/docs/tools/tool-catalog.md",
    "docs/src/content/docs/configuration/config-reference.md",
  ]);
  if (!referenceDiff.trim()) {
    process.stdout.write(
      `No generated-reference changes in ${range} — no prose suggestion needed.\n`,
    );
    return;
  }
  const docs: Array<{ name: string; content: string }> = [];
  for (const entry of docPaths) {
    const abs = resolveDocPath(REPO_ROOT, entry);
    if (abs === null) {
      process.stderr.write(
        `[docgen] refusing --docs "${entry.trim()}": not a repo-relative markdown file (audit #9)\n`,
      );
      continue;
    }
    if (!existsSync(abs)) continue;
    // Symlink guard: a link inside the repo could still point OUT of it — verify the real path stays
    // contained before reading and shipping the content to the LLM endpoint.
    if (!realpathSync(abs).startsWith(REPO_ROOT)) {
      process.stderr.write(`[docgen] refusing --docs "${entry.trim()}": symlink escapes the repo\n`);
      continue;
    }
    docs.push({ name: relative(REPO_ROOT, abs), content: readFileSync(abs, "utf8").slice(0, 8000) });
  }
  const suggestion = await callLlm(buildProsePrompt(referenceDiff, docs));
  process.stdout.write(
    `# Advisory prose suggestion (review before applying — nothing was written)\n\n${suggestion}\n`,
  );
}

void main();
