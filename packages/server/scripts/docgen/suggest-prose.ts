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
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

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
    "docs/wiki/Configuration-Reference.md",
    "docs/src/content/docs/tools/tool-catalog.md",
    "docs/src/content/docs/configuration/config-reference.md",
  ]);
  if (!referenceDiff.trim()) {
    process.stdout.write(
      `No generated-reference changes in ${range} — no prose suggestion needed.\n`,
    );
    return;
  }
  const docs = docPaths
    .map((p) => p.trim())
    .filter((p) => existsSync(`${REPO_ROOT}${p}`))
    .map((p) => ({ name: p, content: readFileSync(`${REPO_ROOT}${p}`, "utf8").slice(0, 8000) }));
  const suggestion = await callLlm(buildProsePrompt(referenceDiff, docs));
  process.stdout.write(
    `# Advisory prose suggestion (review before applying — nothing was written)\n\n${suggestion}\n`,
  );
}

void main();
