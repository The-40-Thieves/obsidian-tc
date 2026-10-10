import type { Tool } from "@modelcontextprotocol/server";
import type { ToolRegistry } from "./registry";

/**
 * Per-tool `securitySchemes` for ChatGPT's "OAuth or no authentication" (mixed) mode, enabled by
 * `auth.anonymousDiscovery: "list"`. Shape per https://developers.openai.com/apps-sdk/build/auth and
 * https://developers.openai.com/apps-sdk/reference (verified 2026-10-10): a top-level tool field,
 * mirrored in `_meta.securitySchemes` for clients that only read `_meta`; entries are
 * `{ type: "noauth" }` or `{ type: "oauth2", scopes }`.
 *
 * Every tool here is `oauth2`, never `noauth`: an anonymous `tools/call` is refused at the HTTP edge
 * (transports/http.ts), so declaring `noauth` would promise ChatGPT a call that cannot succeed. The
 * scopes are the tool's own `requiredScopes`; a facade tool that fronts many tools (triad/domain
 * mode) declares the default scopes, which is what a sign-in that names none is granted.
 */
export type SecurityScheme = { type: "oauth2"; scopes: string[] };

/** `list` with every tool carrying its `securitySchemes`, or `list` untouched when the mode is off. */
export function advertiseSchemes<L extends { tools: Tool[] }>(
  opts: { securitySchemes?: readonly string[]; registry: ToolRegistry },
  list: L,
): L {
  const fallback = opts.securitySchemes;
  if (!fallback) return list;
  const scopesOf = new Map(opts.registry.list().map((d) => [d.name, d.requiredScopes] as const));
  const tools = list.tools.map((tool) => {
    const securitySchemes: SecurityScheme[] = [
      { type: "oauth2", scopes: [...(scopesOf.get(tool.name) ?? fallback)] },
    ];
    return { ...tool, securitySchemes, _meta: { ...tool._meta, securitySchemes } } as Tool;
  });
  return { ...list, tools };
}
