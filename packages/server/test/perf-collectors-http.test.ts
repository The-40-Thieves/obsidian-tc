// THE-495 (family 12): HTTP cold/warm handshake. The metric that matters is the cost of the
// per-request server+transport construction in transports/http.ts — the thing THE-463 proposes
// caching — so the collector must exercise the real app, not a stub.
//
// Hard constraint from the ticket: the harness must NOT bind a network port. Hono's app.fetch()
// runs the full request pipeline in-process, so the handshake is measured without a listener.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectHttp, collectHttpConcurrency } from "../eval/perf/collectors/http";
import { buildVault } from "../eval/perf/harness";
import { SCENARIOS } from "../eval/perf/scenarios";

describe("http handshake collector (THE-495, family 12)", () => {
  it("emits handshake_ok plus cold/warm timings with correct classes and units", async () => {
    const v = await buildVault(SCENARIOS.small);
    try {
      const samples = await collectHttp(v);
      const byKey = Object.fromEntries(samples.map((s) => [s.key, s]));

      const ok = byKey["http.handshake_ok"];
      const cold = byKey["http.cold_ms"];
      const warm = byKey["http.warm_ms"];

      expect(ok).toBeDefined();
      expect(cold).toBeDefined();
      expect(warm).toBeDefined();

      // handshake_ok is the gate: a failed handshake must fail the build, not warn.
      expect(ok?.value).toBe(1);
      expect(ok?.unit).toBe("bool");
      expect(ok?.class).toBe("hard");
      expect(ok?.direction).toBe("exact");

      for (const s of [cold, warm]) {
        expect(s?.unit).toBe("ms");
        expect(s?.class).toBe("warn");
        expect(s?.direction).toBe("higher-worse");
        expect(s?.value).toBeGreaterThan(0);
      }
    } finally {
      v.cleanup();
    }
  });

  it("performs a real MCP initialize round-trip, not a stubbed one", async () => {
    // If the collector short-circuited (or the app rejected the request), handshake_ok would be 0.
    // This asserts the pipeline actually produced a protocol response.
    const v = await buildVault(SCENARIOS.small);
    try {
      const samples = await collectHttp(v);
      const ok = samples.find((s) => s.key === "http.handshake_ok");

      expect(ok?.value).toBe(1);
    } finally {
      v.cleanup();
    }
  });

  // The "no network listener" rule is a REQUIREMENT, not a style choice: binding a port would add
  // accept/TCP cost to the very measurement, and would make the harness contend for ports in CI.
  // Asserted structurally, because the natural way to "fix" a future handshake problem is to reach
  // for serve() — and nothing else would catch that.
  it("never binds a port: the collector must not import a server-starting API", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../eval/perf/collectors/http.ts", import.meta.url)),
      "utf8",
    );

    expect(src).not.toMatch(/@hono\/node-server/);
    expect(src).not.toMatch(/\bserve\s*\(/);
    expect(src).not.toMatch(/\blisten\s*\(/);
    // ...and it must be exercising the in-process pipeline instead.
    expect(src).toMatch(/app\.fetch\s*\(/);
  });
});

// THE-503 Part 2 scenario coverage: 2 and 8 concurrent HTTP callers.
describe("http concurrency collector (THE-503, Part 2)", () => {
  it("emits ok-count + p99 for both the 2- and 8-caller concurrency levels", async () => {
    const v = await buildVault(SCENARIOS.small);
    try {
      const samples = await collectHttpConcurrency(v);
      const byKey = Object.fromEntries(samples.map((s) => [s.key, s]));

      for (const concurrency of [2, 8]) {
        const okCount = byKey[`http.concurrent${concurrency}_ok_count`];
        const p99 = byKey[`http.concurrent${concurrency}_p99_ms`];

        expect(okCount).toBeDefined();
        expect(okCount?.value).toBe(concurrency); // every concurrent handshake must succeed
        expect(okCount?.class).toBe("hard");
        expect(okCount?.direction).toBe("exact");

        expect(p99).toBeDefined();
        expect(p99?.value).toBeGreaterThan(0);
        expect(p99?.class).toBe("warn");
        expect(p99?.direction).toBe("higher-worse");
      }
    } finally {
      v.cleanup();
    }
  });

  it("never binds a port either", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../eval/perf/collectors/http.ts", import.meta.url)),
      "utf8",
    );
    expect(src).not.toMatch(/@hono\/node-server/);
    expect(src).not.toMatch(/\bserve\s*\(/);
    expect(src).not.toMatch(/\blisten\s*\(/);
  });
});
