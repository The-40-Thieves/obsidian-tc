// Domain 27 — URI generation (G2.1 / THE-182). generate_uri is a pure string
// builder: it constructs an obsidian:// URI from an action + params, touches no
// vault state, requires no scope, and never mutates. Core actions (open/search/new)
// emit the built-in obsidian:// scheme; daily/command/hookmark/advanced emit the
// Advanced URI plugin scheme. The `vault` argument is used verbatim (the caller
// passes the vault's display name) so the builder stays pure — it does not consult
// the registry. Every value is percent-encoded so paths, queries, and fragments
// round-trip safely.
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../mcp/registry";
import { defineTool } from "../m1/define";

export type UriAction = "open" | "search" | "new" | "daily" | "command" | "hookmark" | "advanced";

const ACTIONS = ["open", "search", "new", "daily", "command", "hookmark", "advanced"] as const;

/** Join [key, value] pairs into a query string, encoding values and dropping empties. */
function qs(pairs: Array<[string, string | undefined]>): string {
  return pairs
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
    .join("&");
}

/**
 * Build an obsidian:// URI for the given action. Throws invalid_input when the
 * params do not satisfy the action's required shape (a string is expected and a
 * required key is missing or non-string).
 */
export function buildObsidianUri(
  action: UriAction,
  params: Record<string, unknown>,
  vault?: string,
): string {
  const str = (k: string): string | undefined => {
    const val = params[k];
    if (val === undefined || val === null) return undefined;
    if (typeof val !== "string")
      throw err.invalidInput(`param '${k}' must be a string`, { action, key: k });
    return val;
  };
  const required = (k: string): string => {
    const s = str(k);
    if (s === undefined || s === "")
      throw err.invalidInput(`action '${action}' requires param '${k}'`, { action, key: k });
    return s;
  };

  switch (action) {
    case "open": {
      let file = required("file");
      const heading = str("heading");
      const block = str("block");
      if (heading) file += `#${heading}`;
      else if (block) file += `#^${block}`;
      return `obsidian://open?${qs([
        ["vault", vault],
        ["file", file],
      ])}`;
    }
    case "search":
      return `obsidian://search?${qs([
        ["vault", vault],
        ["query", required("query")],
      ])}`;
    case "new":
      return `obsidian://new?${qs([
        ["vault", vault],
        ["file", required("file")],
        ["content", str("content")],
      ])}`;
    case "daily":
      return `obsidian://advanced-uri?${qs([
        ["vault", vault],
        ["daily", "true"],
        ["mode", str("mode")],
        ["data", str("data")],
      ])}`;
    case "command":
      return `obsidian://advanced-uri?${qs([
        ["vault", vault],
        ["commandid", required("commandid")],
      ])}`;
    case "hookmark":
      return `obsidian://advanced-uri?${qs([
        ["vault", vault],
        ["filepath", required("filepath")],
        ["uid", str("uid")],
      ])}`;
    default: {
      // advanced: escape hatch — arbitrary key=value params onto advanced-uri.
      const pairs: Array<[string, string | undefined]> = [["vault", vault]];
      let extras = 0;
      for (const [k, val] of Object.entries(params)) {
        if (val === undefined || val === null) continue;
        pairs.push([k, typeof val === "string" ? val : String(val)]);
        extras++;
      }
      if (extras === 0)
        throw err.invalidInput("action 'advanced' requires at least one param", { action });
      return `obsidian://advanced-uri?${qs(pairs)}`;
    }
  }
}

const GenerateUriInput = z
  .object({
    vault: z.string().min(1).optional(),
    action: z.enum(ACTIONS),
    params: z.record(z.string(), z.unknown()).prefault({}),
  })
  .strict();

/** Domain 27 tool factory. No deps — generate_uri is a pure utility. */
export function buildUriTools(): ToolDefinition[] {
  return [
    defineTool({
      name: "generate_uri",
      description:
        "Build an obsidian:// URI for a target (open/search/new/daily/command/hookmark/advanced). Pure string builder — touches no vault state, requires no scope. The vault display name is used verbatim.",
      inputSchema: GenerateUriInput,
      requiredScopes: [],
      handler: (input) => ({ uri: buildObsidianUri(input.action, input.params, input.vault) }),
    }),
  ];
}
