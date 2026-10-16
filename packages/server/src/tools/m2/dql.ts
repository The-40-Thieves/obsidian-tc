// search_dql / search_vault(mode: dql): the Dataview bridge call, lifted out of search-tools.ts to
// keep that file under the line ceiling.
import { err } from "@the-40-thieves/obsidian-tc-shared";
import type { CallerContext } from "../../mcp/registry";
import { filterBridgeDqlRowsByAcl, filterBridgeItemsByAcl } from "../../vault/acl-read-filter";
import type { M2Deps } from "./shared";

interface DqlResult {
  headers?: string[];
  rows: unknown[][];
  note_paths: string[];
}

/** Apply the shared bridge path judgement to a Dataview result: `rows` by every nested Link/TASK
 *  path, `note_paths` as bare paths. Only the declared fields are returned, so an undeclared
 *  sibling the plugin adds cannot carry a hidden note's path or text. Lives here to keep
 *  search-tools.ts under the production-file line ceiling. */
export function filterDqlResult(
  ctx: Pick<CallerContext, "acl" | "grantedScopes">,
  root: string,
  result: unknown,
  tool: string,
): DqlResult {
  if (
    typeof result !== "object" ||
    result === null ||
    Array.isArray(result) ||
    !Array.isArray((result as { rows?: unknown }).rows)
  )
    throw err.pluginIncompatible("companion returned an unexpected response payload", { tool });
  const record = result as DqlResult;
  const rows = filterBridgeDqlRowsByAcl(ctx.acl, root, ctx.grantedScopes, record.rows, tool);
  const notePaths = Array.isArray(record.note_paths) ? record.note_paths : [];
  const note_paths = filterBridgeItemsByAcl(ctx.acl, root, ctx.grantedScopes, notePaths, {
    tool,
    barePath: true,
  }) as string[];
  return { ...(record.headers ? { headers: record.headers } : {}), rows, note_paths };
}

// Execute a DQL query via the shared Dataview bridge (wired by cli.ts). Absent
// bridge => plugin_missing (honest "not configured"); a live but degraded bridge
// surfaces plugin_missing / plugin_unreachable / dql_error from openBridge + the
// transport. Read-only by contract; the companion rejects non-read DQL.
export async function runDql(
  deps: M2Deps,
  vaultId: string,
  dql: string,
  format: string,
): Promise<DqlResult> {
  if (!deps.dataviewBridge)
    throw err.pluginMissing(
      "DQL requires the Dataview companion-plugin bridge, which is not configured",
      { plugin: "dataview" },
    );
  const { client, timeoutMs } = deps.dataviewBridge(vaultId);
  return client.request<DqlResult>({
    method: "POST",
    path: "/dataview/dql",
    body: { dql, format },
    plugin: "dataview",
    timeoutMs,
  });
}
