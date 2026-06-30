import type { GetPromptResult, ListPromptsResult } from "@modelcontextprotocol/sdk/types.js";
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
  build: (args: Record<string, string>) => string;
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
    })),
  };
}

/** prompts/get — render a built-in prompt. Throws on an unknown name or a missing required arg. */
export function getPrompt(name: string, args: Record<string, string> | undefined): GetPromptResult {
  const def = PROMPTS.find((p) => p.name === name);
  if (!def) throw err.invalidInput(`unknown prompt: ${name}`, { name });
  const a = args ?? {};
  for (const arg of def.arguments)
    if (arg.required && !a[arg.name])
      throw err.invalidInput(`prompt ${name} requires argument: ${arg.name}`, {
        name,
        argument: arg.name,
      });
  return {
    description: def.description,
    messages: [{ role: "user", content: { type: "text", text: def.build(a) } }],
  };
}
