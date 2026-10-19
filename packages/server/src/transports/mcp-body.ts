// The one read of a `/mcp` POST body. The route reads it before the anonymous-discovery gate, so the
// gate and the MCP handler both work from the same parsed value and the body is never read twice.
import { DEFAULT_MAX_REQUEST_BODY_SIZE } from "@modelcontextprotocol/server";
import type { Context } from "hono";
import { ANONYMOUS_BODY_DEADLINE_MS, MAX_ANONYMOUS_BODY_BYTES } from "./anonymous-discovery";
import { readBoundedBody } from "./bounded-body";

export interface McpBodyBounds {
  /** Largest body, in bytes, that is read. A larger one is refused with 413. */
  maxBytes: number;
  /** Time allowed for the whole body to arrive. Past it the answer is 408. */
  deadlineMs: number;
}

export type McpBodyResult =
  /** `parsed` is undefined when the body is not JSON (JSON.parse never yields undefined). */
  | { ok: true; parsed: unknown }
  /** The 413 or 408 answer, a JSON-RPC error that closes the connection. */
  | { ok: false; response: Response };

/** Authenticated callers: the MCP SDK's own request-body limit, and 30 s to deliver it. */
export const AUTHENTICATED_BODY_BOUNDS: McpBodyBounds = {
  maxBytes: DEFAULT_MAX_REQUEST_BODY_SIZE,
  deadlineMs: 30_000,
};

/** An anonymous discovery candidate: a few hundred bytes, and 10 s, since nothing identifies it yet. */
export const ANONYMOUS_BODY_BOUNDS: McpBodyBounds = {
  maxBytes: MAX_ANONYMOUS_BODY_BYTES,
  deadlineMs: ANONYMOUS_BODY_DEADLINE_MS,
};

/** Reads the request body under `bounds` and parses it as JSON. */
export async function readMcpBody(c: Context, bounds: McpBodyBounds): Promise<McpBodyResult> {
  const read = await readBoundedBody(c.req.raw, bounds);
  if (!read.ok && read.status !== 400) {
    c.header("Connection", "close");
    const message = read.status === 413 ? "request body too large" : "request body timeout";
    return {
      ok: false,
      response: c.json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }, read.status),
    };
  }
  try {
    // An unreadable body (400) is empty here, so it fails the parse like any other bad body.
    const text = new TextDecoder().decode(read.ok ? read.bytes : new Uint8Array());
    return { ok: true, parsed: JSON.parse(text) };
  } catch {
    return { ok: true, parsed: undefined };
  }
}
