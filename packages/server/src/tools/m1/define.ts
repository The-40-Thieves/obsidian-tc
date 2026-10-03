// Typed tool builder. Lets each handler see its Zod-inferred input type while
// the registry stores handlers at the `unknown` input boundary. The erasure is
// sound: dispatch validates rawInput against inputSchema before the handler
// runs, so by the time the handler executes the input matches z.infer<S>.
import type { z } from "zod";
import type { CallerContext, ToolDefinition, ToolDomain, ToolIcon } from "../../mcp/registry";
import type { AclOp } from "../../vault/acl-path";

/** `B`: the fields `resolveTarget` adds to the validated input (none by default). `pathAcl`,
 *  `precheck` and `handler` run after that merge, so they see `z.infer<S> & B`. */
export interface ToolSpec<S extends z.ZodTypeAny, O, B extends object = Record<never, never>> {
  /** THE-583: may this tool run as a background TASK when the client asks (`params.task`)?
   *  Opt-in — see ToolDefinition.taskAugmentable. */
  taskAugmentable?: boolean;
  name: string;
  /** THE-513: see ToolDefinition.domain — required here too so defineTool's cast to
   *  ToolDefinition can never paper over a missing domain at a call site. */
  domain: ToolDomain;
  /** THE-513 Part 2: this tool's target-vault input field name, when it has one. See
   *  ToolDefinition.vaultArg — declared here too for the same reason `domain` is: a production
   *  tool with a vault-shaped input field but no declaration is a gap `vault-arg-coverage.test.ts`
   *  catches, not silence. */
  vaultArg?: string;
  /** THE-513 Part 2: declares that this tool's input schema exposes a whole-operation idempotency
   *  key (see ToolDefinition.acceptsIdempotencyKey). Cross-checked against the runtime extraction
   *  by `idempotency-declaration-coverage.test.ts` in both directions. */
  acceptsIdempotencyKey?: boolean;
  description: string;
  inputSchema: S;
  /** Optional output schema (Zod object) advertised as the tool's `outputSchema` (THE-278). */
  outputSchema?: z.ZodType<O>;
  requiredScopes: string[];
  /** Hand-declared classification labels for tool-visibility scoping (THE-219), matched against
   *  toolVisibility.hiddenTags / disabledTags. Declare ONLY what mcp/tool-tags.ts cannot derive
   *  (`external-network`, bridge tools with a generic scope, topic labels): scopes, destructive
   *  flags, HITL gating and domain are computed at registration, and the registry stores the union.
   *  Registration throws on a tag outside the vocabulary or one that is derived. */
  tags?: string[];
  /** Optional MCP 2025-11-25 icons metadata (THE-278). */
  icons?: ToolIcon[];
  destructive?: boolean;
  /** THE-824: see ToolDefinition.conditionallyDestructive — display-only, never read by dispatch. */
  conditionallyDestructive?: boolean;
  precheck?: (input: z.infer<S> & B, ctx: CallerContext) => void | Promise<void>;
  /** See ToolDefinition.resolveTarget: the fields returned here are merged into the input. */
  resolveTarget?: (input: z.infer<S>, ctx: CallerContext) => B | Promise<B>;
  /** See ToolDefinition.checkResolvedTarget. */
  checkResolvedTarget?: (resolved: Readonly<B>, ctx: CallerContext) => void;
  scopeClass?: string;
  /** THE-414: declarative folder-ACL path extraction — the vault-relative paths this tool touches,
   *  tagged by op, so runDispatch enforces the folder ACL centrally (handler-side enforcePathAcl
   *  stays as defense-in-depth). See ToolDefinition.pathAcl. Extractors must mirror the handler's
   *  own enforcePathAcl calls; paths a handler computes at runtime (not derivable from input, e.g.
   *  backlink-rewrite targets) stay handler-enforced only. */
  pathAcl?: (
    input: z.infer<S> & B,
    env?: { root: string },
  ) => ReadonlyArray<{ op: AclOp; path: string }>;
  /** See ToolDefinition.confirmationTargets. */
  confirmationTargets?: ToolDefinition<z.infer<S>>["confirmationTargets"];
  /** See ToolDefinition.deniedItems. */
  deniedItems?: (output: O) => readonly string[];
  handler: (input: z.infer<S> & B, ctx: CallerContext) => O | Promise<O>;
}

export function defineTool<S extends z.ZodTypeAny, O, B extends object = Record<never, never>>(
  spec: ToolSpec<S, O, B>,
): ToolDefinition {
  return spec as unknown as ToolDefinition;
}
