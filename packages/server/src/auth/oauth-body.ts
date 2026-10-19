// The body guard on every /oauth/* route. The handlers read a form or JSON body before anything
// authenticates the caller, so the guard reads that body first: under a byte cap and a deadline (a
// declared body that is dribbled in must not hold the connection), and into memory, so the handler
// reads a buffered copy of a body that is already spent on the wire.
import type { MiddlewareHandler } from "hono";
import { readBoundedBody } from "../transports/bounded-body";

/** Largest form or JSON body an /oauth/* request may send. */
export const FORM_MAX_BYTES = 16 * 1024;
/** Time an /oauth/* request body has to arrive in full before the answer is 408. */
export const OAUTH_BODY_DEADLINE_MS = 10_000;

/**
 * Caps and times the request body of each /oauth/* request. Every refusal closes the connection: the
 * body is not read to its end, so the socket cannot be reused for the next request.
 */
export function oauthBodyGuard(opts: { deadlineMs?: number } = {}): MiddlewareHandler {
  const deadlineMs = opts.deadlineMs ?? OAUTH_BODY_DEADLINE_MS;
  return async (c, next) => {
    // No body stream means no body. A stream with no framing header (an in-process Request) is read
    // under the same bounds: the cap applies to what arrives, not only to what is declared.
    if (c.req.raw.body === null) return next();
    const body = await readBoundedBody(c.req.raw, { maxBytes: FORM_MAX_BYTES, deadlineMs });
    if (!body.ok) {
      c.header("connection", "close");
      if (body.status === 413) return c.text("Payload Too Large", 413);
      if (body.status === 408) return c.text("Request Timeout", 408);
      return c.text("Bad Request", 400);
    }
    // The handlers' c.req.text() / c.req.json() now read the buffered copy from memory.
    c.req.raw = new Request(c.req.raw, { body: body.bytes });
    return next();
  };
}
