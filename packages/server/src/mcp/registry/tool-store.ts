import type { ToolVisibilityConfig } from "@the-40-thieves/obsidian-tc-shared";
import { isListed, type VisibilityCaller } from "../visibility";
import type { ToolDefinition } from "./types";

/**
 * WP4.1: the registered-tool map and its storage operations, split out of ToolRegistry so a later
 * slice can move the dispatch body independently without also carrying registration/listing along.
 *
 * ToolRegistry owns one instance and delegates register/list/listVisible/has/get to it — a
 * concrete composition, not an interface: the map's WP4 section is explicit that this is a
 * "concrete module split, not a port," and constraint 6 forbids a new abstraction (interface,
 * registry seam) without a second production implementation. `get` is not part of the public
 * ToolRegistry API (dispatch always called `this.tools.get(name)` directly); it exists here only
 * because dispatch, still living in registry.ts, needs a way to reach a stored definition now that
 * the Map itself moved out from under it.
 */
export class ToolStore {
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool registry; the handler input type is contravariant, so ToolDefinition<unknown, unknown> is not assignable from a specific ToolDefinition.
  private readonly tools = new Map<string, ToolDefinition<any, any>>();

  // biome-ignore lint/suspicious/noExplicitAny: accepts any specific ToolDefinition for storage in the heterogeneous registry (see the tools map above).
  register(def: ToolDefinition<any, any>): void {
    if (this.tools.has(def.name)) throw new Error(`duplicate tool: ${def.name}`);
    this.tools.set(def.name, def);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /** Tools advertised by tools/list: the registered set minus those the visibility config
   *  hides/disables (THE-219) and those the caller cannot dispatch (THE-250). `list()` stays
   *  the full registered set. */
  listVisible(toolVisibility: ToolVisibilityConfig, caller?: VisibilityCaller): ToolDefinition[] {
    return [...this.tools.values()].filter((def) => isListed(def, toolVisibility, caller));
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  // biome-ignore lint/suspicious/noExplicitAny: same heterogeneous-registry reason as the map above.
  get(name: string): ToolDefinition<any, any> | undefined {
    return this.tools.get(name);
  }
}
