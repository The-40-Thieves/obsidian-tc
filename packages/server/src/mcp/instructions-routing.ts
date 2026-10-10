// The routing sentence at the head of the server `instructions`: HOW a client reaches a tool on the
// surface it was given. Codex truncates instructions at 512 characters and Claude Code at 2,048
// (code.claude.com/docs/en/mcp), so this leads the text and is complete well inside both cuts;
// test/tool-budget-profiles.test.ts holds each variant to that. Split out of facade.ts, which is at
// the comment-style ratchet's threshold.
import type { FacadeMode } from "./facade-mode";
import type { AdvertiseSubset } from "./tool-profiles";

/** Which tool surface the instructions describe. "triad"/"flat" are known at construction; a
 *  "subset" is a flat list that is deliberately not the whole catalog (tool-profiles.ts); "generic"
 *  (domain, auto: resolved per client, after the text is built) says it conditionally. */
export type InstructionsSurface = "triad" | "flat" | "subset" | "generic";

/** The instructions surface for a server's configured facade mode and tool-budget subset. An unset
 *  mode is flat, matching `createFacadeModeResolver`. */
export function instructionsSurfaceOf(
  facadeMode: FacadeMode | "auto" | undefined,
  advertise: AdvertiseSubset | undefined,
): InstructionsSurface {
  if (advertise !== undefined && advertise !== "all") return "subset";
  if (facadeMode === undefined || facadeMode === "flat") return "flat";
  return facadeMode === "triad" ? "triad" : "generic";
}

/** Every tool it names is on every surface that gets that variant (the flat variants name only
 *  tools in the essentials profile), so the guidance never points at an unlisted tool. */
export function routingGuidance(surface: InstructionsSurface, hasResources: boolean): string {
  if (surface === "triad")
    return (
      "Route every request through three tools: find_capability(query) locates a tool, " +
      "describe_capability(name) returns its schema, call_capability(name, args) runs it. " +
      "Good first calls: search_vault, read_note, list_notes."
    );
  if (surface === "generic")
    return (
      "If find_capability is listed, use it to locate a tool, describe_capability for its schema " +
      "and call_capability to run it; otherwise call the listed tools directly by name."
    );
  const direct =
    "Every tool is listed directly: call it by name. To find notes use search_vault or " +
    "search_text, to read use read_note, to change use patch_note or write_note, for task " +
    "context use vault_context.";
  if (surface === "flat") return direct;
  const catalog = hasResources ? " (obsidian-tc://catalog lists all)" : "";
  return `${direct} A curated subset; other tools are still callable by name${catalog}.`;
}
