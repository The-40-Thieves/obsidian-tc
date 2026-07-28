import type { GetPromptResult, ListPromptsResult } from "@modelcontextprotocol/server";
import { err } from "@the-40-thieves/obsidian-tc-shared";

interface PromptArg {
  name: string;
  description: string;
  required: boolean;
}
interface PromptDef {
  name: string;
  description: string;
  arguments: PromptArg[];
  /** Optional MCP 2025-11-25 icons metadata (THE-278). No built-in prompt sets it yet. */
  icons?: { src: string; mimeType?: string; sizes?: string[] }[];
  build: (args: Record<string, string>) => string;
}

/** THE-448: clamp a caller-supplied facet count. Prompt arguments are strings with no schema
 *  behind them — the MCP protocol types them as Record<string, string> — so this normalizes
 *  garbage ("lots", "-3", "2.5", "99") to the default rather than rendering a prompt that asks
 *  for an unbounded number of searches. The ceiling matches vault_graph_search's `queries` cap so
 *  a caller who does reach for the fan-out instead is not told a number the tool would reject. */
const MAX_FACETS = 8;
const DEFAULT_FACETS = 4;
function clampVariants(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_FACETS;
  return Math.min(n, MAX_FACETS);
}

// Built-in prompt templates. Each renders a single user message that primes the agent to use
// obsidian-tc's tools; the prompts themselves perform no vault access.
const PROMPTS: PromptDef[] = [
  {
    name: "summarize_note",
    description: "Summarize a single vault note.",
    arguments: [
      {
        name: "path",
        description: "Vault-relative path to the note (e.g. projects/foo.md)",
        required: true,
      },
    ],
    build: (a) =>
      `Read the note at \`${a.path}\` with the read_note tool, then give a concise summary of its key points, decisions, and open questions. Cite headings where useful.`,
  },
  {
    name: "find_connections",
    description: "Find and explain how notes relate to a topic or note.",
    arguments: [
      {
        name: "topic",
        description: "A topic, question, or note path to explore connections for",
        required: true,
      },
    ],
    build: (a) =>
      `Use vault_graph_search (or search_vault) to find the notes most related to "${a.topic}". Then explain how the top results connect to each other and to "${a.topic}", grouping by theme and citing note paths.`,
  },
  {
    // THE-448: decompose -> per-facet retrieve -> synthesize with citations + open questions.
    //
    // This prompt deliberately does NOT drive vault_graph_search's `queries[]` fan-out, and the
    // reason is measured rather than stylistic. On the n=250 golden set, fan-out vs single-query
    // (both path-deduped, identical code, paired):
    //
    //   ΔnDCG@10  -0.047  p=0.0004  SIGNIFICANT, fails the Δ>-0.015 ship floor
    //   ΔMRR@10   -0.063  p=0.0011  SIGNIFICANT, fails the floor
    //   Δrecall@10 -0.002  p=0.82   ns — ties on 228 of 250 queries
    //
    // The fan-out retrieves the SAME documents in a WORSE order. Sliced, the harm concentrates
    // off the multi-hop set: queries with labelled bridge paths (n=103) are near-neutral at
    // -0.0085, single-hop queries (n=147) lose -0.0746. The ticket's predicted gain on compound
    // queries did not appear on this corpus.
    //
    // There is also a structural reason to keep the searches separate here even if the ranking
    // were neutral: cross-variant RRF discards WHICH facet surfaced each note, and that
    // attribution is exactly what step 3 needs to group evidence by facet. Fusing throws away the
    // information this workflow is built to use.
    name: "decompose_and_research",
    description:
      "Answer a compound question by decomposing it into facets, retrieving per facet, and synthesizing with citations and open questions.",
    arguments: [
      {
        name: "question",
        description: "The compound or multi-facet question to research against the vault",
        required: true,
      },
      {
        name: "max_variants",
        description: "How many additional phrasings to fan out over (1-8, default 4)",
        required: false,
      },
    ],
    build: (a) =>
      // Step 2 issues SEPARATE searches rather than one `queries[]` fan-out, and that is a
      // measured choice, not an oversight. See the header comment above.
      `Research this question against the vault: "${a.question}"

1. DECOMPOSE. Identify the distinct facets the question spans (entities, domains, time periods, or sub-claims). Write up to ${clampVariants(a.max_variants)} facet queries — each self-contained, and phrased in the vocabulary that facet would actually be written in rather than the question's wording repeated.
2. RETRIEVE PER FACET. Run a SEPARATE vault_graph_search for the original question and for each facet query. Keep the result lists separate — knowing which facet surfaced a note is what lets you attribute claims in step 3, and it is information a fused list cannot give back.
3. SYNTHESIZE. Answer the original question, grouping by facet and naming which facet each piece of evidence came from. Cite the note path for every claim. Where the retrieved notes disagree, say so rather than picking one silently.
4. OPEN QUESTIONS. End with what the vault does NOT answer — facets that returned nothing relevant, and claims resting on a single note.`,
  },
  {
    name: "recent_changes_digest",
    description: "Summarize what changed in the vault recently.",
    arguments: [
      {
        name: "limit",
        description: "How many recent notes to review (default 20)",
        required: false,
      },
    ],
    build: (a) =>
      `List the ${a.limit ?? "20"} most recently modified notes, then summarize what changed and surface anything that looks unfinished or worth following up on.`,
  },
];

/** prompts/list — the built-in prompt catalog. */
export function listPrompts(): ListPromptsResult {
  return {
    prompts: PROMPTS.map((p) => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments,
      ...(p.icons ? { icons: p.icons } : {}),
    })),
  };
}

/** prompts/get — render a built-in prompt. Throws on an unknown name or a missing required arg. */
export function getPrompt(name: string, args: Record<string, string> | undefined): GetPromptResult {
  const def = PROMPTS.find((p) => p.name === name);
  if (!def) throw err.invalidInput(`unknown prompt: ${name}`, { name });
  const a = args ?? {};
  // Reject a required arg only when it is absent or an explicit empty string; this keeps
  // "not provided" distinct from "provided but blank" rather than collapsing both via a
  // falsy check (which would also trip on a legitimate value like 0 for future non-string args).
  for (const arg of def.arguments)
    if (arg.required && (!(arg.name in a) || a[arg.name] === ""))
      throw err.invalidInput(`prompt ${name} requires argument: ${arg.name}`, {
        name,
        argument: arg.name,
      });
  return {
    description: def.description,
    messages: [{ role: "user", content: { type: "text", text: def.build(a) } }],
  };
}
