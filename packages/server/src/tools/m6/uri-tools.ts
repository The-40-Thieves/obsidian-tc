// Domain 27 — URI generation (G2.1 / THE-182). generate_uri is a pure string
// builder: it constructs an obsidian:// URI from an action + params, touches no
// vault state, requires no scope, and never mutates. Core actions (open/search/new)
// emit the built-in obsidian:// scheme; daily/command/hookmark/advanced emit the
// Advanced URI plugin scheme. The `vault_name` argument is used verbatim (the caller
// passes the vault's DISPLAY name, not its id — see the THE-589 note below) so the
// builder stays pure: it does not consult the registry. Every value is percent-encoded
// so paths, queries, and fragments round-trip safely.
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

// THE-589: the field is `vault_name`, NOT `vault`, and the distinction is load-bearing.
//
// This is an Obsidian DISPLAY NAME, copied verbatim into the `vault=` query parameter of the
// obsidian:// URI. It is not a vault id. But the central vault-binding guard (THE-267,
// mcp/registry.ts) matches on the argument NAME — any string argument called `vault` is compared
// against the caller's bound vault id — so while this field was called `vault`, a bound HTTP caller
// whose Obsidian display name differed from its configured vault id got `forbidden` from a tool
// that requires no scope, reads nothing, and only concatenates a string. Reproduced before the
// rename: `{vault:"My Notes"}` with bound vault `main` returned
// `forbidden: vault is not the caller's bound vault`.
//
// Renaming is the right fix rather than exempting the tool: the guard's convention stays intact
// (no security-relevant bypass to justify and maintain), and the field now says what it holds. A
// caller still passing `vault` gets a clear strict-schema rejection naming the unknown key, which
// is a far better error than a confusing `forbidden`.
//
// The durable fix is a DECLARED vault argument rather than one matched by name — see THE-546's
// manifest work, where "vault binding inferred from a key literally spelled `vault`" is one of four
// axes derived from convention. This rename should not be undone to accommodate that; it is correct
// independently.
const GenerateUriInput = z
  .object({
    vault_name: z.string().min(1).optional(),
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
        "Build an obsidian:// URI for a target (open/search/new/daily/command/hookmark/advanced). Pure string builder — touches no vault state, requires no scope. `vault_name` is the Obsidian DISPLAY NAME (not a vault id) and is used verbatim.",
      inputSchema: GenerateUriInput,
      requiredScopes: [],
      handler: (input) => ({ uri: buildObsidianUri(input.action, input.params, input.vault_name) }),
    }),
  ];
}
