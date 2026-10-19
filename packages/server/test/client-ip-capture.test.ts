// The client address is read from the TCP peer before any middleware can replace the request. Under
// Bun the peer is readable only from the request the runtime created (`env.requestIP`), and hono's
// bodyLimit replaces `c.req.raw` with `new Request(c.req.raw, …)` for a chunked request, so a peer
// read after it is lost. Incident: a chunked POST to /oauth/login under Bun had no client address,
// so the per-IP login limit was skipped for it.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { captureClientPeer, socketClientIp } from "../src/auth/client-ip";

const PEER = "203.0.113.9";

/** A Bun-like runtime: the address is known only for the request object it created. */
function bunEnv(original: Request) {
  return {
    requestIP: (req: Request) => (req === original ? { address: PEER } : null),
  };
}

function appReplacingTheRequest(withCapture: boolean): Hono {
  const app = new Hono();
  if (withCapture) app.use("*", captureClientPeer);
  // What hono's bodyLimit does on a chunked request (middleware/body-limit/index.js).
  app.use("/oauth/*", async (c, next) => {
    c.req.raw = new Request(c.req.raw);
    await next();
  });
  app.post("/oauth/login", (c) => c.text(socketClientIp(c) ?? "unattributed"));
  return app;
}

describe("client address captured before the request is replaced", () => {
  it("RED: a peer read after `c.req.raw` is replaced is still the address the runtime reported", async () => {
    const original = new Request("https://x.test/oauth/login", { method: "POST", body: "x" });
    const res = await appReplacingTheRequest(true).fetch(original, bunEnv(original));
    expect(await res.text()).toBe(PEER);
  });

  it("without the capture, the replaced request has no peer (the failure the capture exists for)", async () => {
    const original = new Request("https://x.test/oauth/login", { method: "POST", body: "x" });
    const res = await appReplacingTheRequest(false).fetch(original, bunEnv(original));
    expect(await res.text()).toBe("unattributed");
  });
});

describe("a peer already captured by a parent is not overwritten", () => {
  it("RED: a second capture keeps the peer the first one recorded, once the runtime no longer reports it", async () => {
    // A parent app registers the capture, then a body-rebuilding middleware, then a child that
    // registers the capture again (what createHttpApp does when mounted under the parent).
    const app = new Hono();
    app.use("*", captureClientPeer);
    app.use("*", async (c, next) => {
      c.req.raw = new Request(c.req.raw);
      await next();
    });
    app.use("*", captureClientPeer);
    app.post("/oauth/login", (c) => c.text(socketClientIp(c) ?? "unattributed"));
    const original = new Request("https://x.test/oauth/login", { method: "POST", body: "x" });
    const res = await app.fetch(original, bunEnv(original));
    expect(await res.text()).toBe(PEER);
  });
});

describe("fallback without the capture middleware", () => {
  it("a bare app still reads the peer from the runtime's request object", async () => {
    const app = new Hono();
    app.post("/x", (c) => c.text(socketClientIp(c) ?? "unattributed"));
    const original = new Request("https://x.test/x", { method: "POST", body: "x" });
    const res = await app.fetch(original, bunEnv(original));
    expect(await res.text()).toBe(PEER);
  });

  it("a bare app still reads the Node socket's peer", async () => {
    const app = new Hono();
    app.get("/x", (c) => c.text(socketClientIp(c) ?? "unattributed"));
    const env = { incoming: { socket: { remoteAddress: PEER } } };
    const res = await app.fetch(new Request("https://x.test/x"), env);
    expect(await res.text()).toBe(PEER);
  });
});
