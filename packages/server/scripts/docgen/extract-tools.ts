// docgen — tools extractor (THE-471). Enumerates the full registered surface and maps each
// ToolDefinition through describeCapability (the same descriptor tools/list advertises) into a
// ToolDoc. This is the slice that fills the `GENERATED: tools` block in the wiki's Tool Reference, so
// the write surface (patch_note, append_note, …) can never go undocumented again.
import { describeCapability } from "../../src/mcp/facade";
import { buildFullRegistry } from "./build-registry";
import type { ToolDoc } from "./model";

interface Capability {
  name: string;
  description: string;
  input_schema: unknown;
  output_schema?: unknown;
  required_scopes: string[];
}

/** Extract every registered MCP tool as ToolDoc[] (sorted by name). */
export function extractTools(): ToolDoc[] {
  const registry = buildFullRegistry();
  const out: ToolDoc[] = [];
  for (const def of registry.list()) {
    const cap = describeCapability(def) as unknown as Capability;
    out.push({
      name: def.name,
      description: def.description,
      requiredScopes: def.requiredScopes,
      tags: def.tags ?? [],
      destructive: def.destructive === true,
      inputSchema: cap.input_schema,
      ...(cap.output_schema !== undefined ? { outputSchema: cap.output_schema } : {}),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
