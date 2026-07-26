// THE-448: generate the phrasing variants that eval/run.ts --fanout consumes.
//
// The multi-query fan-out deliberately has NO server LLM: vault_graph_search takes `queries[]` and
// the CLIENT writes the paraphrases (the same MCP-native split as hypothetical_answer). So the eval
// cannot measure the shipped path without standing in for that client. This script is that stand-in
// — it is eval TOOLING, not part of the server, and nothing in src/ imports it.
//
// Output: { "<exact golden query_text>": ["variant", ...] } at --out, which run.ts keys on exactly.
// Writing to a FILE rather than generating inline is the point: the variants become a fixed input
// that every arm of the A/B sees identically, so a re-run measures the fusion and not the
// generator's sampling. Regenerate only when you intend to change what is being measured.
//
// usage:
//   OPENAI_API_KEY=$LITELLM_AGENT_KEY bun eval/gen-fanout-variants.ts \
//     --golden ~/obsidian-tc-eval/multi-hop-golden-set.yaml \
//     --out    ~/obsidian-tc-eval/fanout-variants.json \
//     [--base-url http://100.78.123.100:4001/v1] [--model openai/gpt-5.4-nano] [--n 3]
import { readFileSync, writeFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { runWithConcurrency } from "../src/util/concurrency";
import { GoldenSetSchema } from "./metrics";

const DEFAULT_BASE_URL = "http://100.78.123.100:4001/v1";
const DEFAULT_MODEL = "openai/gpt-5.4-nano";
const DEFAULT_VARIANTS = 3;
// vault_graph_search caps `queries` at 8; generating more would produce a file whose fan-out the
// tool would reject, so the ceiling belongs here too.
const MAX_VARIANTS = 8;
const CONCURRENCY = 6;

const SYSTEM = [
  "You rewrite a search question as alternative phrasings for a personal knowledge vault.",
  "Each phrasing must be self-contained and searchable on its own, and must target a DIFFERENT facet",
  "of the original: a distinct entity, domain, or sub-claim. Use the vocabulary that facet would",
  "actually be written in — do not restate the original's wording with synonyms swapped in.",
  "Output ONLY the phrasings, one per line. No numbering, no commentary, no quotes.",
].join(" ");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function variantsFor(
  query: string,
  baseUrl: string,
  model: string,
  apiKey: string,
  n: number,
): Promise<string[]> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Write exactly ${n} alternative phrasings of:\n\n${query}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`${model} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return (
    (body.choices?.[0]?.message?.content ?? "")
      .split("\n")
      .map((l) => l.replace(/^[\s\-*\d.)]+/, "").trim())
      // A variant identical to the original is dropped here rather than in run.ts: run.ts collapses
      // duplicates silently, so a generator that echoed the question back would look like a fan-out
      // of n+1 in the file and behave as a fan-out of 1.
      .filter((l) => l.length > 3 && l.toLowerCase() !== query.toLowerCase())
      .slice(0, n)
  );
}

async function main(): Promise<void> {
  const goldenPath = arg("golden");
  const outPath = arg("out");
  if (!goldenPath || !outPath) {
    process.stderr.write(
      "usage: bun eval/gen-fanout-variants.ts --golden <set.yaml> --out <variants.json> [--base-url URL] [--model M] [--n 3]\n",
    );
    process.exit(2);
  }
  const apiKey = process.env.OPENAI_API_KEY ?? process.env.LITELLM_AGENT_KEY;
  if (!apiKey) throw new Error("set OPENAI_API_KEY (or LITELLM_AGENT_KEY) for the gateway");
  const baseUrl = arg("base-url") ?? DEFAULT_BASE_URL;
  const model = arg("model") ?? DEFAULT_MODEL;
  const n = Math.min(MAX_VARIANTS, Math.max(1, Number(arg("n") ?? DEFAULT_VARIANTS)));

  const golden = GoldenSetSchema.parse(parseYaml(readFileSync(goldenPath, "utf8")));
  process.stderr.write(`${golden.queries.length} queries -> ${n} variants each via ${model}\n`);

  let failed = 0;
  const results = await runWithConcurrency(golden.queries, CONCURRENCY, async (q) => {
    try {
      const v = await variantsFor(q.query_text, baseUrl, model, apiKey, n);
      process.stderr.write(v.length > 0 ? "." : "0");
      return [q.query_text, v] as const;
    } catch (e) {
      failed++;
      process.stderr.write("x");
      process.stderr.write(`\n  ${q.id}: ${e instanceof Error ? e.message : String(e)}\n`);
      return [q.query_text, [] as string[]] as const;
    }
  });
  process.stderr.write("\n");

  const out = Object.fromEntries(results.filter(([, v]) => v.length > 0));
  const covered = Object.keys(out).length;
  // An empty or near-empty file is the failure mode that reads as success downstream: run.ts would
  // fan out over nothing and the A/B would report "no effect" for a fan-out that never ran. Refuse
  // to write one rather than leave that to be noticed later.
  if (covered === 0)
    throw new Error("every query failed; refusing to write an empty variants file");
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  process.stderr.write(
    `wrote ${outPath}: ${covered}/${golden.queries.length} queries with variants (${failed} request failure(s))\n`,
  );
}

void main();
