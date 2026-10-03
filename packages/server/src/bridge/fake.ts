// Deterministic in-process fake of the companion-plugin REST transport. It returns
// canned per-route responses (and simulated network/abort failures) so the probe,
// capability cache, degradation, execute-scope, HITL, and every proxy tool are
// tested with zero Obsidian. Routes are keyed by "METHOD <pathname>", where the
// pathname includes the /obsidian-tc/v1 prefix
// (e.g. "POST /obsidian-tc/v1/dataview/query"). The returned value is a real Response: the
// transport reads the body as a stream under its timeout and size cap, which a bare
// Response-like object (ok/status/json) cannot satisfy.
import type { BridgeFetch } from "./transport";

export interface FakeRoute {
  /** HTTP status; defaults to 200. */
  status?: number;
  /** JSON body returned (a bridge envelope); defaults to { ok: true, result: {} }. */
  body?: unknown;
  /** Reject as a generic network failure (connection refused, DNS, etc.). */
  networkError?: boolean;
  /** Reject as an aborted request (timeout simulation). */
  abort?: boolean;
}

export interface FakeRequestInfo {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface FakeBridgeOptions {
  routes?: Record<string, FakeRoute>;
  /** Fallback when no route key matches; defaults to a 404 plugin_missing. */
  fallback?: FakeRoute;
  /** Observe each request for header/URL/body assertions. */
  onRequest?: (info: FakeRequestInfo) => void;
}

type FetchInput = Parameters<BridgeFetch>[0];
type FetchInit = Parameters<BridgeFetch>[1];
type FetchReturn = Awaited<ReturnType<BridgeFetch>>;

function fakeResponse(status: number, body: unknown): FetchReturn {
  const nullBody = status === 204 || status === 205 || status === 304;
  return new Response(nullBody ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function urlOf(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

export function fakeBridgeTransport(opts: FakeBridgeOptions = {}): BridgeFetch {
  const fn = (input: FetchInput, init?: FetchInit): Promise<FetchReturn> => {
    const url = urlOf(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === "string" ? init.body : undefined;
    opts.onRequest?.({ url, method, headers, body });

    const pathname = new URL(url).pathname;
    const route = opts.routes?.[`${method} ${pathname}`] ?? opts.fallback;
    if (!route)
      return Promise.resolve(
        fakeResponse(404, { ok: false, code: "plugin_missing", message: "no such route" }),
      );
    if (route.networkError) return Promise.reject(new Error("ECONNREFUSED"));
    if (route.abort) {
      const e = new Error("The operation was aborted");
      e.name = "AbortError";
      return Promise.reject(e);
    }
    return Promise.resolve(
      fakeResponse(route.status ?? 200, route.body ?? { ok: true, result: {} }),
    );
  };
  return fn;
}
