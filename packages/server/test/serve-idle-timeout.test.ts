// THE-697 — Bun.serve's idleTimeout defaults to 10 SECONDS, and serveHono never passed one. Every
// MCP request the server handles inherited that default, so `index_vault` over a 1,147-note vault
// returned `RemoteProtocolError: Server disconnected without sending a response` to the caller
// while the container logged "[Bun.serve]: request timed out after 10 seconds" and the work
// completed asynchronously anyway. A hard failure reported for a successful operation.

import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { BUN_IDLE_TIMEOUT_SECONDS, serveHono } from "../src/transports/serve";

const g = globalThis as unknown as { Bun?: unknown };
const original = g.Bun;
afterEach(() => {
  if (original === undefined) delete g.Bun;
  else g.Bun = original;
});

describe("THE-697 serveHono idleTimeout", () => {
  it("passes an explicit idleTimeout to Bun.serve", async () => {
    let seen: Record<string, unknown> | undefined;
    g.Bun = {
      serve: (opts: Record<string, unknown>) => {
        seen = opts;
        return { port: 1234, stop: () => undefined };
      },
    };

    await serveHono(new Hono(), { host: "127.0.0.1", port: 0 });

    // Asserting the VALUE reaches Bun, not merely that a constant exists. A named constant that no
    // call site passes is the exact shape of the inert-feature defects this repo keeps finding.
    //
    // The typeof assertion is not decoration: written as `toBe(BUN_IDLE_TIMEOUT_SECONDS)` alone
    // this test PASSED against the unfixed code, because an unpassed option and an undefined
    // constant are both `undefined` and compare equal. It was green while proving nothing.
    expect(typeof seen?.idleTimeout).toBe("number");
    expect(seen?.idleTimeout).toBe(BUN_IDLE_TIMEOUT_SECONDS);
  });

  it("uses a value Bun will accept and that beats the 10s default", () => {
    // Bun rejects anything above 255 (seconds); 0 disables the timeout entirely, which would leak
    // genuinely dead connections. Both ends are real failure modes, so both are pinned.
    expect(BUN_IDLE_TIMEOUT_SECONDS).toBeGreaterThan(10);
    expect(BUN_IDLE_TIMEOUT_SECONDS).toBeLessThanOrEqual(255);
  });
});
