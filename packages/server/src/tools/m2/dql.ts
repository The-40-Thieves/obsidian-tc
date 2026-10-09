// search_dql / search_vault(mode: dql): the Dataview bridge call, lifted out of search-tools.ts to
// keep that file under the line ceiling.
import { err } from "@the-40-thieves/obsidian-tc-shared";
import type { M2Deps } from "./shared";

interface DqlResult {
  headers?: string[];
  rows: unknown[][];
  note_paths: string[];
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
