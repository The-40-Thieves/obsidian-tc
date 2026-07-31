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
    .describe("Tags whose tools are hidden from tools/list but remain callable."),
  disabledTags: z
    .array(z.string())
    .default([])
    .describe("Tags whose tools are hidden and rejected at dispatch."),
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
// which was itself cancelled — see facade.ts's note). Every registered tool stays callable by name
// regardless of mode, so nothing is removed.
//
// The "triad" default is a DECISION, not an accident, and re-litigating it has a specific bar:
// docs/adr/0006-the-default-surface-is-the-triad.md. Short version — 3 advertised tools is already
// leaner than every comparable server (market range 6-15), and switching to "domain" wants an
// eval that measures tool-SELECTION accuracy, which does not exist yet.
export const ToolFacadeConfigSchema = z.object({
  mode: z
    .enum(["triad", "domain", "flat"])
    .default("triad")
    .describe(
      "Which surface tools/list advertises: `triad` exposes three meta-tools (find/describe/call_capability), `domain` about a dozen domain meta-tools, `flat` the full tool surface. Every registered tool stays callable by name in every mode.",
    ),
});
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
