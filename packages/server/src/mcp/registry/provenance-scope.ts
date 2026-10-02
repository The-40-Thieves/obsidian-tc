// Dispatch's side of write provenance, kept out of dispatch.ts (which sits at biome's line cap).
// One scope per dispatch: `begin` hashes the named paths just before a MUTATING handler runs,
// `settle` appends the record exactly once — `ok` the moment the handler returns (an overflowed or
// schema-rejected response still wrote), `error` only from the catch, where the recorder keeps it
// only when a named path really changed. With no sink wired every method is a no-op.
import { vaultArgOf } from "./input-binding";
import type { CallerContext, ProvenanceSink, RegistryOptions, ToolDefinition } from "./types";

export interface ProvenanceScope {
  begin(def: ToolDefinition, input: unknown, ctx: CallerContext): Promise<void>;
  settle(outcome: "ok" | "error", result?: unknown): Promise<void>;
}

export function provenanceScope(
  sink: ProvenanceSink | undefined,
  rootResolver: RegistryOptions["rootResolver"],
): ProvenanceScope {
  let pending: object | undefined;
  let installedOn: CallerContext | undefined;
  const uninstall = (): void => {
    if (installedOn !== undefined) delete installedOn.recordPendingWrite;
    installedOn = undefined;
  };
  return {
    async begin(def, input, ctx) {
      if (sink === undefined) return;
      const vault = vaultArgOf(def, input) ?? ctx.vaultId;
      const p = await sink.begin(def, input, ctx, rootResolver?.(vault));
      pending = p;
      if (sink.recordPending !== undefined) {
        ctx.recordPendingWrite = (after) => sink.recordPending?.(p, after);
        installedOn = ctx;
      }
    },
    async settle(outcome, result) {
      const p = pending;
      pending = undefined;
      uninstall();
      if (p !== undefined) await sink?.commit(p, outcome, result);
    },
  };
}
