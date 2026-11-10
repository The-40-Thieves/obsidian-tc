import { type RegistryOptions, ToolRegistry } from "../src/mcp/registry";

type Options = Omit<RegistryOptions, "rootResolver">;

/** No filesystem vaults: pathless tools work, but any pathAcl tool still fails closed. */
export function pathlessRegistry(options: Options = {}): ToolRegistry {
  return new ToolRegistry({ ...options, rootResolver: () => undefined });
}

/** Drop every registered tool's pathAcl, so a test reaches the handler-side ACL checks that
 *  dispatch's central stage would otherwise refuse first. */
export function stripPathAcl(registry: ToolRegistry): void {
  for (const tool of registry.list()) tool.pathAcl = undefined;
}
