// A helper module the fixture calls with a slice of the context: the scan must follow the call.
import type { CallerContext } from "../../src/mcp/registry";

export function readsHitlRoute(c: Pick<CallerContext, "hitlRoute">): unknown {
  return c.hitlRoute;
}
