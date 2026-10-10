// Tool-name hygiene over every advertised surface. Pure over its input (tool-surface.ts feeds it
// the real surfaces) so each failure shape is unit-testable with a synthetic bad name.
//
// Why these rules (clients prefix the tool name and cap the result at 63-64 chars):
//   * Claude Code `mcp__<server>__<tool>`, Gemini `mcp_<server>_<tool>`: a long name overflows the
//     cap; VS Code truncates at 64 and silently DROPS a collision. 40 leaves room for a 20-char
//     server name plus either prefix.
//   * Grok Build drops names that do not match `^[a-zA-Z_][a-zA-Z0-9_-]*$` or contain a dot; Meta
//     allows at most one dot. `^[a-z][a-z0-9_]*$` is inside every one of those.
//   * LiteLLM (BerriAI/litellm #44831) resolves a name shared by two servers to the wrong one, so a
//     name this server shares with the generic vocabulary (`read`, `run`, ...) is a latent hijack.

/** Prefix budget: `mcp__` + a 20-char server name + `__` is 27 chars; 64 - 27 = 37. 40 is the cap
 *  with a little headroom, and the longest name today is 28. */
export const NAME_MAX_LENGTH = 40;
export const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

/** An extractor that found fewer names than this broke; the surface did not shrink to this. */
export const MIN_NAMES_CHECKED = 150;

/** Bare verbs/nouns that other servers also advertise. A name here is shared by construction. */
export const GENERIC_NAMES: ReadonlySet<string> = new Set([
  "read",
  "write",
  "list",
  "get",
  "query",
  "run",
  "execute",
  "find",
  "create",
  "update",
  "delete",
  "call",
  "open",
  "help",
  "status",
  "info",
  "set",
  "add",
  "remove",
  "send",
  "load",
  "save",
  "describe",
  "check",
  "ping",
  "echo",
  "test",
  "ask",
  "chat",
  "index",
  "tools",
  "fetch",
  "search",
]);

/** Generic names this server advertises on purpose. Add one only with the reason it must stay. */
export const GENERIC_ALLOWLIST: Readonly<Record<string, string>> = {
  search:
    "Standard OpenAI connector name (ChatGPT deep research looks the pair up by exact name). Owner decision: never rename.",
  fetch:
    "Standard OpenAI connector name, the other half of the pair with `search`. Owner decision: never rename.",
};

/** Names legitimately advertised on two surfaces as DIFFERENT tools. Add one only with the reason. */
export const CROSS_SURFACE_ALLOWLIST: Readonly<Record<string, string>> = {
  search:
    "The `search` domain meta-tool (domain mode) shares its name with the standard `search` tool (flat/triad). The surfaces are mutually exclusive per session, domain mode never advertises the direct tool, and the domain is reachable only by that name; renaming either is a breaking change (the tool is an owner decision).",
};

export interface NamedTool {
  name: string;
  description?: string | undefined;
}

export interface NameAllowlists {
  generic: Readonly<Record<string, string>>;
  crossSurface: Readonly<Record<string, string>>;
}

export const LIVE_ALLOWLISTS: NameAllowlists = {
  generic: GENERIC_ALLOWLIST,
  crossSurface: CROSS_SURFACE_ALLOWLIST,
};

export function checkToolNames(
  surfaces: Readonly<Record<string, readonly NamedTool[]>>,
  allow: NameAllowlists = LIVE_ALLOWLISTS,
): string[] {
  const problems: string[] = [];
  const distinct = new Set<string>();
  const seenGeneric = new Set<string>();

  for (const [surface, tools] of Object.entries(surfaces)) {
    const inSurface = new Set<string>();
    for (const { name } of tools) {
      distinct.add(name);
      if (inSurface.has(name)) problems.push(`${surface}: "${name}" is advertised twice`);
      inSurface.add(name);
      if (name.length > NAME_MAX_LENGTH)
        problems.push(
          `${surface}: "${name}" is ${name.length} chars (max ${NAME_MAX_LENGTH}; clients prefix the name and cap at 63-64)`,
        );
      if (!NAME_PATTERN.test(name))
        problems.push(
          `${surface}: "${name}" does not match ${NAME_PATTERN} (Grok Build drops other names; dots are rejected or limited by Grok and Meta)`,
        );
      if (GENERIC_NAMES.has(name)) {
        seenGeneric.add(name);
        if (!(name in allow.generic))
          problems.push(
            `${surface}: "${name}" is a generic name other servers also use (LiteLLM #44831 resolves shared names to the wrong server); rename it, or allowlist it in GENERIC_ALLOWLIST with the reason`,
          );
      }
    }
  }

  // A name on two surfaces must be the same advertised tool (identical description). The triad's
  // direct `search`/`fetch` ARE the flat tools; the `search` domain meta-tool is not.
  const byName = new Map<string, Array<{ surface: string; description: string }>>();
  for (const [surface, tools] of Object.entries(surfaces)) {
    for (const { name, description } of tools) {
      const list = byName.get(name) ?? [];
      list.push({ surface, description: description ?? "" });
      byName.set(name, list);
    }
  }
  const crossSeen = new Set<string>();
  for (const [name, uses] of byName) {
    const distinctText = new Set(uses.map((u) => u.description));
    if (distinctText.size <= 1) continue;
    crossSeen.add(name);
    if (!(name in allow.crossSurface))
      problems.push(
        `"${name}" names different tools on ${[...new Set(uses.map((u) => u.surface))].join(", ")}; names must be distinct across surfaces (or allowlist it in CROSS_SURFACE_ALLOWLIST with the reason)`,
      );
  }

  // An allowlist entry nothing needs hides the next real collision under a stale excuse.
  for (const name of Object.keys(allow.generic))
    if (!seenGeneric.has(name))
      problems.push(`generic allowlist entry "${name}" matches no advertised tool; remove it`);
  for (const name of Object.keys(allow.crossSurface))
    if (!crossSeen.has(name))
      problems.push(`cross-surface allowlist entry "${name}" matches no collision; remove it`);

  if (distinct.size < MIN_NAMES_CHECKED)
    problems.push(
      `floor: checked ${distinct.size} distinct names (< ${MIN_NAMES_CHECKED}); the surface extractor is broken, not the names`,
    );
  return problems;
}
