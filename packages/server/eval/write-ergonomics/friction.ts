// Friction metrics from the tap proxy's log: client-independent, so both clients are measured the
// same way. Definitions are frozen in PREREGISTRATION.md.
import { readFileSync } from "node:fs";
import type { TapCall } from "./tasks";

export interface TapEntry {
  t: number;
  dir: string;
  tool?: string;
  args?: Record<string, unknown>;
  ms?: number;
  isError?: boolean;
  code?: string;
  recovery?: string;
  bytes?: number;
  text?: string;
  clientInfo?: { name?: string };
}

export interface ErrorRow {
  tool: string;
  code: string;
  /** The server returned a `recovery` instruction. */
  hasRecovery: boolean;
  /** A later call to the same tool succeeded. */
  recovered: boolean;
  excerpt: string;
}

export interface Friction {
  clientName?: string;
  toolsCalls: number;
  discoveryCalls: number;
  realCalls: number;
  errors: number;
  errorsWithRecovery: number;
  errorsRecovered: number;
  /** Calls to the same tool straight after that tool errored. */
  retries: number;
  elicitRequired: number;
  responseBytes: number;
  conciseCalls: number;
  hookFired: boolean;
  errorRows: ErrorRow[];
  sequence: string[];
}

export const readTap = (path: string): TapEntry[] => {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as TapEntry);
  } catch {
    return [];
  }
};

/** The mid-task hook fired straight after an ERRORED call (the first run of the harness did this when a
 *  read failed on the missing `vault`): the external edit landed before the model held any content, so the
 *  trial never exercised the stale-hash path. */
export function hookFiredOnError(tap: TapEntry[]): boolean {
  const i = tap.findIndex((e) => e.dir === "hook");
  return i > 0 && tap[i - 1]?.isError === true;
}

const DISCOVERY = new Set(["find_capability", "describe_capability"]);

export function toCalls(tap: TapEntry[]): TapCall[] {
  return tap
    .filter((e) => e.dir === "s2c" && e.tool && e.tool !== "<tools/list>")
    .map((e) => ({
      tool: e.tool ?? "",
      args: e.args ?? {},
      isError: e.isError === true,
      code: e.code,
    }));
}

export function friction(tap: TapEntry[]): Friction {
  const calls = tap.filter((e) => e.dir === "s2c" && e.tool && e.tool !== "<tools/list>");
  const rows: ErrorRow[] = [];
  let retries = 0;
  calls.forEach((e, i) => {
    if (i > 0 && calls[i - 1]?.isError && calls[i - 1]?.tool === e.tool) retries++;
    if (!e.isError) return;
    rows.push({
      tool: e.tool ?? "",
      code: e.code ?? "unknown",
      hasRecovery: Boolean(e.recovery),
      recovered: calls.slice(i + 1).some((n) => n.tool === e.tool && !n.isError),
      excerpt: (e.text ?? "").slice(0, 240),
    });
  });
  return {
    clientName: tap.find((e) => e.clientInfo)?.clientInfo?.name,
    toolsCalls: calls.length,
    discoveryCalls: calls.filter((e) => DISCOVERY.has(e.tool ?? "")).length,
    realCalls: calls.filter((e) => !DISCOVERY.has(e.tool ?? "")).length,
    errors: rows.length,
    errorsWithRecovery: rows.filter((r) => r.hasRecovery).length,
    errorsRecovered: rows.filter((r) => r.recovered).length,
    retries,
    elicitRequired: rows.filter((r) => r.code === "elicit_required").length,
    responseBytes: calls.reduce((n, e) => n + (e.bytes ?? 0), 0),
    conciseCalls: calls.filter((e) => e.args?.response_format === "concise").length,
    hookFired: tap.some((e) => e.dir === "hook"),
    errorRows: rows,
    sequence: calls.map((e) => `${e.tool}${e.isError ? `!${e.code ?? ""}` : ""}`),
  };
}
