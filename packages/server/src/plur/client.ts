// plur read-API proxy client + degradation gate (M5 / THE-181, G2.1 Domain 24).
//
// plur is an EXTERNAL read-only engram store, reached over the same injectable
// bridge transport the M4 companion bridge uses (so every plur test runs against a
// deterministic in-process fake — no live plur). Unlike the companion bridge plur is
// GLOBAL, not per-vault (the engram store is global and the plur tools take no
// `vault` argument), so one client is built once from the server-root config.
//
// Degradation contract (THE-181 §4):
//   - endpoint unconfigured  -> plugin_missing, with NO network call (openPlur gate).
//   - configured-but-down    -> plugin_unreachable, mapped by the transport's catch.
// The bearer token comes from config/env only and is placed solely in the
// Authorization header by createBridgeClient — never logged, never in an error.
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { type BridgeClient, type BridgeFetch, createBridgeClient } from "../bridge";
import { createLocalPlurClient } from "./local";

/** The narrow read surface both the HTTP bridge client and the local-CLI client satisfy. */
export type PlurClient = Pick<BridgeClient, "request">;

export interface PlurClientConfig {
  /** plur read-API base URL, e.g. http://127.0.0.1:7077. Absent -> no client. */
  endpoint?: string;
  /** Bearer token for the plur read API. Config/env only; never logged. */
  apiKey?: string;
  /** Route prefix under the base URL; defaults to "" (plur's root read API). */
  apiPrefix?: string;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /** Injected transport; defaults to the global fetch. Tests pass the fake. */
  fetchFn?: BridgeFetch;
}

/**
 * Build a read-only bridge client for the global plur engram store, or `undefined`
 * when no endpoint is configured. An undefined client makes every plur tool degrade
 * to plugin_missing with no network call (see openPlur).
 */
export function createPlurClient(cfg: PlurClientConfig | undefined): BridgeClient | undefined {
  if (!cfg?.endpoint) return undefined;
  return createBridgeClient({
    baseUrl: cfg.endpoint,
    apiKey: cfg.apiKey,
    apiPrefix: cfg.apiPrefix ?? "",
    timeoutMs: cfg.timeoutMs,
    fetchFn: cfg.fetchFn,
  });
}

/**
 * Gate every plur tool. An unconfigured endpoint (no client) degrades to
 * plugin_missing WITHOUT touching the network; a configured-but-unreachable endpoint
 * degrades to plugin_unreachable later, at request time, via the transport's catch.
 */
export function openPlur(client: PlurClient | undefined): PlurClient {
  if (!client) throw err.pluginMissing("plur endpoint not configured", { plugin: "plur" });
  return client;
}

/**
 * Select a plur backend from config. A `command` (local plur CLI, THE-208) takes precedence over an
 * HTTP `endpoint`; with neither, returns undefined and every plur tool degrades to plugin_missing.
 */
export function createPlurBackend(
  cfg: (PlurClientConfig & { command?: string[] }) | undefined,
): PlurClient | undefined {
  if (cfg?.command && cfg.command.length > 0)
    return createLocalPlurClient({ command: cfg.command, timeoutMs: cfg.timeoutMs });
  return createPlurClient(cfg);
}
