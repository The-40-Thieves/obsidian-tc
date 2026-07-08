// Typed HTTP client to the companion plugin's REST surface (the /obsidian-tc/v1/*
// routes the companion registers on the Local REST API plugin — G2.2 §3.1). The
// transport is an injectable fetch-like function so every test runs against a
// deterministic in-process fake (bridge/fake.ts), never a live Obsidian. Failures
// map onto the M2 error taxonomy: a transport/HTTP failure means the endpoint did
// not answer (plugin_unreachable); a bridge envelope reporting a plugin is not
// installed maps to plugin_missing. The bearer token comes from vault config/env
// only and is never logged or placed in an error/audit payload.
import { type ErrorCode, err, ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";

/** Injectable transport: the global `fetch` in production, a fake in tests. */
export type BridgeFetch = typeof fetch;

export const DEFAULT_API_PREFIX = "/obsidian-tc/v1";
export const DEFAULT_BRIDGE_TIMEOUT_MS = 5000;

export interface BridgeClientOptions {
  /** Local REST API base, e.g. http://127.0.0.1:27124 */
  baseUrl: string;
  /** Bearer token (the Local REST API key). Config/env only; never logged. */
  apiKey?: string;
  /** Default per-request timeout in ms. */
  timeoutMs?: number;
  /** Injected transport; defaults to the global fetch. */
  fetchFn?: BridgeFetch;
  /** Route prefix; defaults to /obsidian-tc/v1. */
  apiPrefix?: string;
}

export interface BridgeRequest {
  method: "GET" | "POST" | "DELETE";
  /** Path under the api prefix, e.g. "/dataview/query" or "/probe". */
  path: string;
  body?: unknown;
  timeoutMs?: number;
  /** Plugin name surfaced in error details for a degraded call. */
  plugin?: string;
}

interface BridgeEnvelopeErr {
  ok: false;
  code?: string;
  message?: string;
  details?: Record<string, unknown>;
}
interface BridgeEnvelopeOk {
  ok: true;
  result?: unknown;
}
type BridgeEnvelope = BridgeEnvelopeOk | BridgeEnvelopeErr;

// Bridge error codes we pass through verbatim onto our own taxonomy; anything
// else from a misbehaving bridge collapses to plugin_unreachable (retryable).
const PASSTHROUGH_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  "plugin_missing",
  "plugin_unreachable",
  "invalid_input",
  "dql_error",
  "jsonlogic_error",
  "operation_timeout",
  "note_not_found",
  "note_exists",
  "acl_denied",
]);

function mapBridgeError(env: BridgeEnvelopeErr, plugin?: string): ObsidianTcError {
  const message = env.message ?? "bridge returned an error";
  const details: Record<string, unknown> = {
    ...(plugin ? { plugin } : {}),
    ...(env.details ?? {}),
  };
  if (env.code && PASSTHROUGH_CODES.has(env.code))
    return new ObsidianTcError(env.code as ErrorCode, message, details);
  return err.pluginUnreachable(message, { ...details, bridge_code: env.code });
}

export interface NativeResponse<T> {
  /** HTTP status of the native (unprefixed) Local REST API response. */
  status: number;
  /** Whether the status was 2xx. */
  ok: boolean;
  /** Parsed JSON body, or null for an empty / non-JSON body (e.g. a 204). */
  data: T | null;
}

export interface BridgeClient {
  readonly baseUrl: string;
  request<T>(req: BridgeRequest): Promise<T>;
  /**
   * Call a Local REST API *native* route directly: NO /obsidian-tc/v1 prefix, and the
   * response is raw JSON (not a bridge envelope). Used as a companion-independent
   * fallback for the few capabilities LRA implements itself (e.g. GET /commands/).
   * Resolves with the HTTP status + parsed body so callers can branch on `status`;
   * throws plugin_unreachable only when the endpoint does not answer (network/abort).
   */
  requestNative<T>(req: BridgeRequest): Promise<NativeResponse<T>>;
}

export function createBridgeClient(opts: BridgeClientOptions): BridgeClient {
  const fetchFn = opts.fetchFn ?? fetch;
  const prefix = opts.apiPrefix ?? DEFAULT_API_PREFIX;
  const defaultTimeout = opts.timeoutMs ?? DEFAULT_BRIDGE_TIMEOUT_MS;
  const base = opts.baseUrl.replace(/\/+$/, "");

  // Shared transport: fetch `url` with bearer auth + a per-request timeout, mapping a
  // network/abort failure onto plugin_unreachable (the endpoint did not answer). The
  // token is never logged nor placed in an error payload.
  async function doFetch(url: string, r: BridgeRequest): Promise<Awaited<ReturnType<BridgeFetch>>> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), r.timeoutMs ?? defaultTimeout);
    try {
      return await fetchFn(url, {
        method: r.method,
        headers: {
          accept: "application/json",
          ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
          ...(r.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(r.body !== undefined ? { body: JSON.stringify(r.body) } : {}),
        signal: ctrl.signal,
      });
    } catch {
      throw err.pluginUnreachable("bridge request failed", {
        ...(r.plugin ? { plugin: r.plugin } : {}),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    baseUrl: base,
    async request<T>(r: BridgeRequest): Promise<T> {
      const res = await doFetch(`${base}${prefix}${r.path}`, r);

      let env: BridgeEnvelope | undefined;
      try {
        env = (await res.json()) as BridgeEnvelope;
      } catch {
        env = undefined;
      }

      if (env && env.ok === false) throw mapBridgeError(env, r.plugin);
      if (res.ok && env && env.ok === true) return (env.result ?? null) as T;
      // A non-2xx with no usable envelope: surface the HTTP status so the probe
      // can tell "companion not installed" (404) from a transient failure.
      throw err.pluginUnreachable(`bridge HTTP ${res.status}`, {
        ...(r.plugin ? { plugin: r.plugin } : {}),
        http_status: res.status,
      });
    },
    async requestNative<T>(r: BridgeRequest): Promise<NativeResponse<T>> {
      // NO api prefix: Local REST API's own routes live at the server root (e.g. /commands/).
      const res = await doFetch(`${base}${r.path}`, r);
      let data: T | null = null;
      try {
        data = (await res.json()) as T;
      } catch {
        data = null; // empty body (e.g. a 204) or a non-JSON payload.
      }
      return { status: res.status, ok: res.ok, data };
    },
  };
}
