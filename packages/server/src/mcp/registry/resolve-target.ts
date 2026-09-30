// The `resolveTarget` dispatch stage, split out of policy-gates.ts: see ToolDefinition.resolveTarget.
import { ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import { argsHash } from "../../hash";
import { enforceCentralPathAcl } from "./policy-gates";
import type { CallerContext, RegistryOptions, ToolDefinition } from "./types";

/**
 * `resolveTarget` stage (see `ToolDefinition.resolveTarget` and docs/design/mcp-registry-context-types.md):
 * resolve the caller-unsupplied arguments and return the input the rest of dispatch must use, the
 * `recorded` audit arguments, and the args `hash` over them. Undefined for a tool without a resolver.
 * The folder ACL runs on the resolved path HERE, ahead of HITL, and a denial is rethrown without
 * `details.path`: the caller did not name it.
 */
export async function bindResolvedTarget(
  def: ToolDefinition,
  data: unknown,
  rawInput: unknown,
  ctx: CallerContext,
  rootResolver: RegistryOptions["rootResolver"],
): Promise<{ input: unknown; recorded: unknown; hash: string } | undefined> {
  if (!def.resolveTarget) return undefined;
  const bound = await def.resolveTarget(data, ctx);
  const collisions = Object.keys(bound).filter((k) => k in (data as Record<string, unknown>));
  if (collisions.length > 0)
    throw new ObsidianTcError("internal", "resolved target collides with input fields", {
      collisions,
    });
  const input = { ...(data as Record<string, unknown>), ...bound };
  try {
    enforceCentralPathAcl(def, input, ctx, rootResolver);
  } catch (e) {
    if (e instanceof ObsidianTcError && e.details && "path" in e.details) {
      const { path: _discovered, ...rest } = e.details;
      throw new ObsidianTcError(e.code, e.message, rest);
    }
    throw e;
  }
  const recorded = { ...((rawInput ?? {}) as Record<string, unknown>), ...bound };
  return { input, recorded, hash: argsHash(def.name, recorded) };
}
