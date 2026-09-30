// docgen — tools extractor (THE-471). Enumerates the full registered surface and maps each
// ToolDefinition through describeCapability (the same descriptor tools/list advertises) into a
// ToolDoc. This is the slice that fills the `GENERATED: tools` block in the wiki's Tool Reference, so
// the write surface (patch_note, append_note, …) can never go undocumented again.
import { describeCapability } from "../../src/mcp/facade";
import type { ToolDefinition } from "../../src/mcp/registry";
import { isHitlGated } from "../../src/mcp/registry/hitl-declaration";
import { hitlRequired } from "../../src/mcp/registry/policy-gates";
import { buildFullRegistry } from "./build-registry";
import type { ToolConfirmationDoc, ToolDoc } from "./model";

interface Capability {
  name: string;
  description: string;
  input_schema: unknown;
  output_schema?: unknown;
  required_scopes: string[];
  annotations: { read_only: boolean; destructive: boolean };
}

function confirmationOf(def: ToolDefinition): ToolConfirmationDoc {
  if (!isHitlGated(def)) return { required: "never", binds: [] };
  const binds: ToolConfirmationDoc["binds"] = [];
  if (def.pathAcl) binds.push("paths");
  if (typeof def.confirmationTargets === "function") binds.push("state");
  if (def.confirmationTargets === "none") binds.push("arguments");
  return { required: hitlRequired(def) ? "always" : "conditional", binds };
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
      ...(def.domain !== undefined ? { domain: def.domain } : {}),
      annotations: {
        readOnly: cap.annotations.read_only,
        destructive: cap.annotations.destructive,
        idempotent: def.idempotent === true,
      },
      confirmation: confirmationOf(def),
      acceptsIdempotencyKey: def.acceptsIdempotencyKey === true,
      ...(cap.output_schema !== undefined ? { outputSchema: cap.output_schema } : {}),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
