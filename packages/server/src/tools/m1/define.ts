// Typed tool builder. Lets each handler see its Zod-inferred input type while
// the registry stores handlers at the `unknown` input boundary. The erasure is
// sound: dispatch validates rawInput against inputSchema before the handler
// runs, so by the time the handler executes the input matches z.infer<S>.
import type { z } from "zod";
import type { CallerContext, ToolDefinition, ToolIcon } from "../../mcp/registry";

export interface ToolSpec<S extends z.ZodTypeAny, O> {
  name: string;
  description: string;
  inputSchema: S;
  /** Optional output schema (Zod object) advertised as the tool's `outputSchema` (THE-278). */
  outputSchema?: z.ZodType<O>;
  requiredScopes: string[];
  /** Free-form classification labels for tool-visibility scoping (THE-219):
   *  matched against toolVisibility.hiddenTags / disabledTags. */
  tags?: string[];
  /** Optional MCP 2025-11-25 icons metadata (THE-278). */
  icons?: ToolIcon[];
  destructive?: boolean;
  precheck?: (input: z.infer<S>, ctx: CallerContext) => void | Promise<void>;
  scopeClass?: string;
  handler: (input: z.infer<S>, ctx: CallerContext) => O | Promise<O>;
}

export function defineTool<S extends z.ZodTypeAny, O>(spec: ToolSpec<S, O>): ToolDefinition {
  return spec as unknown as ToolDefinition;
}
