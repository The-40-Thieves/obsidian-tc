// WP1.7: extracted from ../config.schema.ts (which stays a compatibility facade re-exporting
// these same symbol names). Leaf schema — imports Zod only, no shared scalars needed here.
//
// Import direction is non-negotiable: this file must never import config.schema.ts,
// server.schema.ts, or any other schema module. None of ToolVisibilityConfigSchema,
// ToolFacadeConfigSchema, or BootstrapDomainSchema chain anything past `z.object(...)` itself;
// BootstrapConfigSchema chains only `.prefault({})` (a default-application combinator, not a
// `.refine`/`.superRefine`) — there is no cross-domain field read to keep back in
// config.schema.ts, so all four move here whole, along with the DEFAULT_DEEP_PHRASES const.
import { z } from "zod";

// Static tool-visibility scoping (THE-219 — parity with turbovault's tool_visibility).
// Shapes the *advertised* tool surface at the Registry.listVisible()/dispatch chokepoints
// without rebuilding capability. Two strengths, with precedence disabled > hidden > listed:
//   - hidden / hiddenTags / requireReadOnly / allowed: drop a tool from tools/list, but it
//     stays callable by name (a lean default surface, not a security boundary).
//   - disabled / disabledTags: drop it from tools/list AND reject it at dispatch, so it
//     behaves as if unregistered.
// `allowed`, when present, is a name allowlist: only those tools are listed (absent = list
// all; an empty array lists none). `requireReadOnly` derives mutation from the required
// scopes (isMutatingScope), so it needs no per-tool annotation. Optional + fully defaulted:
// a config predating THE-219 validates unchanged and an absent block means ALLOW_ALL.
export const ToolVisibilityConfigSchema = z.object({
  allowed: z
    .array(z.string())
    .optional()
    .describe(
      "Name allowlist: only these tools are listed. Absent lists all; an empty array lists none.",
    ),
  hidden: z
    .array(z.string())
    .default([])
    .describe(
      "Tool names dropped from tools/list but still callable by name. A leaner default surface, NOT a security boundary.",
    ),
  disabled: z
    .array(z.string())
    .default([])
    .describe(
      "Tool names dropped from tools/list AND rejected at dispatch, so they behave as if unregistered.",
    ),
  hiddenTags: z
    .array(z.string())
    .default([])
    .describe(
      "Tags whose tools are hidden from tools/list but remain callable. Tags come from the tool-tag vocabulary (for example `destructive`, `bulk`, `external-network`, `domain:git`); see Tool tags in the docs.",
    ),
  disabledTags: z
    .array(z.string())
    .default([])
    .describe(
      "Tags whose tools are hidden and rejected at dispatch. Same tag vocabulary as hiddenTags.",
    ),
  requireReadOnly: z
    .boolean()
    .default(false)
    .describe(
      "List only non-mutating tools. Mutation is derived from each tool's required scopes, so no per-tool annotation is needed. Hides rather than rejects.",
    ),
});
export type ToolVisibilityConfig = z.infer<typeof ToolVisibilityConfigSchema>;

// Tool-surface facade (THE-219 consolidation). Which surface tools/list advertises: "triad" (the
// default) exposes three meta-tools (find/describe/call_capability); "flat" advertises the full
// tool surface (back-compat); "domain" advertises ~a dozen domain meta-tools (landed under THE-275,
// which was itself cancelled — see facade.ts's note); "auto" (THE-1123) is DEPRECATED: it
// now resolves to "triad" for every client (an `autoClients` entry still overrides) and is slated
// for removal in the next major; set an explicit mode. Every registered tool stays callable by name
// regardless of mode, so nothing is removed in any of the four.
//
// The "triad" default is a DECISION, not an accident, and re-litigating it has a specific bar:
// docs/adr/0006-the-default-surface-is-the-triad.md. Short version — 3 advertised tools is already
// leaner than every comparable server (market range 6-15), and switching to "domain" wants an
// eval that measures tool-SELECTION accuracy, which does not exist yet. "auto" does not relitigate
// that default: "auto" never leaves "triad" unless an operator's own `autoClients` says so.
export const ToolFacadeConfigSchema = z.object({
  mode: z
    .enum(["triad", "domain", "flat", "auto"])
    .default("triad")
    .describe(
      "Which surface tools/list advertises: `triad` exposes three meta-tools (find/describe/call_capability), `domain` about a dozen domain meta-tools, `flat` the full tool surface, `auto` is deprecated: it resolves to `triad` for every client (unless `autoClients` overrides) and will be removed in the next major version, so set an explicit mode (recommended: `triad`). Every registered tool stays callable by name in every mode.",
    ),
  // THE-1123 (part a): only consulted when `mode` is "auto". A client's observed `clientInfo.name`
  // is matched against these keys as a case-insensitive SUBSTRING, in this map's own key order,
  // BEFORE the server's built-in table (mcp/facade-auto.ts) — so a key here for a name the built-in
  // table also matches overrides it. First match wins; a client that matches nothing here or in the
  // built-in table gets "triad". Deprecated along with "auto" itself.
  autoClients: z
    .record(z.string().min(1), z.enum(["triad", "domain", "flat"]))
    .optional()
    .describe(
      'Deprecated, only used when mode is "auto". Maps a case-insensitive substring of the connecting client\'s clientInfo.name to a facade mode; checked in this object\'s own key order, before the server\'s built-in table, so an entry here overrides the same substring there. Absent clientInfo.name (most callers today) always falls back to "triad".',
    ),
  // Pure observability over `mode: "auto"` — never changes which mode a client gets. When true, each
  // auto resolution writes one structured `toolFacade.explain` JSON line to stderr and
  // server_health's `toolFacade.explanation` returns the calling client's explanation (signals
  // consulted, the rule that fired, the mode chosen). Server-level like the rest of `toolFacade`:
  // the facade decision is per connecting client, not per vault.
  explainAutoMode: z
    .boolean()
    .default(false)
    .describe(
      'Only meaningful when mode is "auto". Explain the auto-mode decision without changing it: one structured `toolFacade.explain` log line per resolution (client name, matched rule, chosen mode) and `server_health`\'s `toolFacade.explanation` for the calling client. Default false.',
    ),
  // Whether tools/list advertises each tool's `outputSchema`. Results carry `structuredContent` and
  // a text block either way; this only changes the ADVERTISEMENT. "full" (default) is today's
  // behaviour. "omit" is the opt-out for clients that mishandle the field: Cursor blanks a server
  // whose outputSchema root is not an object, Claude Desktop rejects some drafts, and claude.ai
  // is reported to fail tools that declare one.
  outputSchema: z
    .enum(["full", "omit"])
    .default("full")
    .describe(
      'Whether tools/list advertises each tool\'s `outputSchema`. "full" (the default) is unchanged. "omit" drops it from every advertised tool for clients that mishandle the field (reported for claude.ai; Claude Desktop with older schema drafts; Cursor); tool results still carry `structuredContent` and a text block.',
    ),
  // Deployment-level and orthogonal to `mode` above: `mode` picks what a given SESSION is
  // advertised, `profile` picks which tools are VISIBLE and CALLABLE at all, resolved once
  // when the registry is built. Registration itself is profile-invariant — every tool is always
  // registered (see registered-tool-count.ts); `profile` only changes dispatch-time visibility.
  // "full" (the default) leaves every tool visible/callable, unchanged from today. "core" is an
  // OPT-IN, smaller curated surface — a structural/dependency curation (see
  // mcp/tool-profiles.ts's module comment for the evidence per family), not a claim that the
  // moved tools are unwanted. A tool `core` hides still exists (`inspect_visibility` reports
  // `disabled_by_profile`); describe_capability/call_capability answer it with a
  // `capability_hidden` error naming this config key, never a silent dispatch failure.
  profile: z
    .enum(["full", "core"])
    .default("full")
    .describe(
      'Which tools are visible/callable for this process — registration itself is unaffected (every tool is always registered). "full" (the default) leaves every tool visible/callable, unchanged from today. "core" is an opt-in, smaller curated surface. Orthogonal to `mode`: `mode` picks what a session is ADVERTISED, `profile` picks what is CALLABLE. A tool `core` hides answers describe_capability/call_capability with a `capability_hidden` error rather than a silent failure.',
    ),
});
export type ToolFacadeConfig = z.infer<typeof ToolFacadeConfigSchema>;
// Tool response shaping (GH #1027). `response_format` is a per-call parameter on the tools that
// return more than an acknowledgement: "detailed" is the full payload every tool has always
// returned, "concise" trims it to the high-signal fields. The per-call parameter (or its legacy
// `verbosity` alias) wins; this block is only the operator's default for a call that names neither.
// The shipped default is "detailed", so a config that predates this block behaves byte-for-byte as
// before. Errors are never trimmed, and a warning or safety signal survives "concise".
export const ResponseFormatSchema = z
  .enum(["concise", "detailed"])
  .describe(
    'How much a tool returns: "detailed" is the full payload, "concise" only the high-signal fields (write acks shrink to vault, path and content_hash; errors and safety warnings are never trimmed).',
  );
export type ResponseFormat = z.infer<typeof ResponseFormatSchema>;

export const ToolDefaultsConfigSchema = z
  .object({
    responseFormat: ResponseFormatSchema.default("detailed").describe(
      'Default response_format for a tool call that sets neither `response_format` nor the legacy `verbosity` alias. Shipped default "detailed" (unchanged output); set "concise" once to cut the output of every tool that supports response_format, without each agent passing the parameter. It is also the only selector for MCP resources/read, which takes no parameters (concise returns the note body without its frontmatter).',
    ),
  })
  .prefault({});
export const ToolsConfigSchema = z
  .object({
    defaults: ToolDefaultsConfigSchema.describe(
      "Defaults applied to tool calls that do not set the parameter themselves.",
    ),
  })
  .prefault({});
export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;

// Session-bootstrap routing (THE-101). Server-level, not per-vault: the routing table is a
// judgment value supplied by config, never baked into the public tree. session_bootstrap triages
// the opening message to lightweight | standard | deep and reads the resolved context notes. A
// `domain` matches when any of its lowercased `signals` is a substring of the message, pulling its
// `paths`; `deepPaths` load in deep mode; a `deepPhrases` hit forces deep on a catch-up opener.
// Fully defaulted (empty table + generic catch-up phrases), so a config predating THE-101 validates
// unchanged and the tool degrades to lightweight with nothing to load.
export const BootstrapDomainSchema = z.object({
  name: z.string().min(1).describe("Label for this routing domain."),
  signals: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      "Lowercased substrings; the domain matches when any one appears in the opening message.",
    ),
  paths: z
    .array(z.string().min(1))
    .min(1)
    .describe("Context notes loaded when this domain matches."),
});
export const DEFAULT_DEEP_PHRASES = [
  "where did we leave off",
  "what's open",
  "whats open",
  "catch me up",
  "current state",
  "where are we",
  "what should i be working on",
  "what should i work on",
];

export const BootstrapConfigSchema = z
  .object({
    deepPaths: z
      .array(z.string().min(1))
      .default([])
      .describe("Context notes loaded additionally in deep mode."),
    domains: z
      .array(BootstrapDomainSchema)
      .default([])
      .describe(
        "Signal-to-path routing table. Empty means the tool degrades to lightweight with nothing to load.",
      ),
    maxPaths: z
      .number()
      .int()
      .positive()
      .max(50)
      .default(10)
      .describe("Ceiling on how many context notes one bootstrap may read."),
    deepPhrases: z
      .array(z.string().min(1))
      .default(DEFAULT_DEEP_PHRASES)
      .describe("Catch-up phrases that force deep mode regardless of the triage result."),
  })
  .prefault({});
export type BootstrapConfig = z.infer<typeof BootstrapConfigSchema>;
