// Typed tool builder. Lets each handler see its Zod-inferred input type while
// the registry stores handlers at the `unknown` input boundary. The erasure is
// sound: dispatch validates rawInput against inputSchema before the handler
// runs, so by the time the handler executes the input matches z.infer<S>.
import type { z } from "zod";
import type { CallerContext, ToolDefinition } from "../../mcp/registry";

export interface ToolSpec<S extends z.ZodTypeAny, O> {
  name: string;
  description: string;
  inputSchema: S;
  requiredScopes: string[];
  destructive?: boolean;
  handler: (input: z.infer<S>, ctx: CallerContext) => O | Promise<O>;
}

export function defineTool<S extends z.ZodTypeAny, O>(spec: ToolSpec<S, O>): ToolDefinition {
  return spec as unknown as ToolDefinition;
}
