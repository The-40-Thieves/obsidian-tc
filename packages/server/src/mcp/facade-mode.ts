// THE-1123: `FacadeMode`'s canonical home. Split out of facade.ts (which re-exports it, so every
// existing `import type { FacadeMode } from "./facade"` call site keeps compiling unchanged) so
// that mcp/registry/types.ts can name this type WITHOUT importing facade.ts — facade.ts imports
// FROM ./registry (TOOL_DOMAINS, ToolDefinition, ToolRegistry), and registry.ts imports FROM
// ./registry/types, so registry/types.ts -> facade.ts would be a real import cycle (registry/types
// -> facade -> registry -> registry/types), exactly the class check:boundaries
// (dependency-cruiser) rejects even for a type-only edge — see registry/types.ts's own use.
export type FacadeMode = "triad" | "domain" | "flat";
