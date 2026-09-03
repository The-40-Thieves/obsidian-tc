// THE-934 fix round 4 (6), closing the round-3 review's NB2 — the plane's BACKGROUND gateway
// client (plane-wiring.ts's `bgRoles`) is built by `planeRoles(attempts, timeoutMs, excludeFilter)`
// and then wrapped in `guardGatewayRoles`. Round 3 fixed the missing 3rd argument, and
// plane-gateway-timeout.test.ts proves that planeRoles' OWN port enforces a filter it is handed —
// but nothing behavioural proved the WIRING hands it one. The only oracle for that was
// egress-port-inventory.test.ts's regex over plane-wiring.ts's source: real, but textual, and a
// source scan cannot see a value.
//
// This file is the behavioural half. It drives the REAL `wireJobHandlers`, intercepts the
// `planeRoles` call it makes, and then exercises the roles object planeRoles RETURNED — before
// plane-wiring's own `guardGatewayRoles` wrap, which is the layer NB2 wanted removed from the
// picture. A regression that drops the argument leaves the port with `compileEgressFilter([])` and
// the excluded declaration sails through, which is the assertion below.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRoles } from "../src/plane/gateway";

const spy = vi.hoisted(() => ({
  calls: [] as Array<{ args: unknown[]; roles: GatewayRoles | null }>,
}));

vi.mock("../src/runtime/tool-wiring", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime/tool-wiring")>();
  return {
    ...actual,
    // Delegates to the REAL planeRoles: the roles captured here are the ones plane-wiring goes on
    // to use, not a stand-in. Only the observation is added.
    planeRoles: (...args: Parameters<typeof actual.planeRoles>) => {
      const roles = actual.planeRoles(...args);
      spy.calls.push({ args, roles });
      return roles;
    },
  };
});

const { wireJobHandlers } = await import("../src/runtime/plane-wiring");
const { compileEgressFilter, hasExcludePatterns, isExcludedPath } = await import(
  "../src/plane/egress-filter"
);
const { EgressViolationError } = await import("../src/plane/egress-guard");

const ENV_URL = "OBSIDIAN_TC_GATEWAY_URL";
const ENV_TOKEN = "OBSIDIAN_TC_GATEWAY_TOKEN";
let savedUrl: string | undefined;
let savedToken: string | undefined;
let savedFetch: typeof globalThis.fetch;

beforeEach(() => {
  savedUrl = process.env[ENV_URL];
  savedToken = process.env[ENV_TOKEN];
  savedFetch = globalThis.fetch;
  process.env[ENV_URL] = "http://gateway.invalid";
  process.env[ENV_TOKEN] = "test-token";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ model: "m", choices: [{ message: { content: "ok" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof globalThis.fetch;
  spy.calls.length = 0;
});

afterEach(() => {
  if (savedUrl === undefined) delete process.env[ENV_URL];
  else process.env[ENV_URL] = savedUrl;
  if (savedToken === undefined) delete process.env[ENV_TOKEN];
  else process.env[ENV_TOKEN] = savedToken;
  globalThis.fetch = savedFetch;
});

/** Deps wireJobHandlers never reads before building the plane's roles. Cast rather than
 *  constructed, matching plane-enabled-gates-ingest-and-jobs.test.ts's stub idiom: building a real
 *  registry/acl/queue here would test those, not the wiring. */
const stub = <T>(): T => ({}) as T;

const INTERACTIVE_ROLES = {
  extract: async () => ({ text: "", model: "m" }),
  synthesize: async () => ({ text: "", model: "m" }),
  judge: async () => ({ text: "", model: "m" }),
};

function wireWith(egressExcludePaths: string[]): void {
  wireJobHandlers({
    registry: stub(),
    db: stub(),
    acl: stub(),
    jobQueue: stub(),
    roles: INTERACTIVE_ROLES,
    plane: { enabled: true },
    embeddingProvider: stub(),
    experientialOpen: false,
    experientialDb: stub(),
    vaults: [],
    // Present, so the wiring takes its own longer-budget planeRoles branch rather than falling
    // back to the interactive seam.
    gatewayMaxAttempts: 1,
    gatewayTimeoutMs: 5_000,
    egressExcludePaths,
  } as never);
}

describe("plane-wiring builds the plane's gateway PORT with the configured filter (THE-934 fix round 4, 6)", () => {
  it("threads a filter that actually excludes — the compiled value, not merely an argument in the source", () => {
    wireWith(["Private/**"]);
    expect(spy.calls).toHaveLength(1);
    const filter = spy.calls[0]?.args[2] as ReturnType<typeof compileEgressFilter> | undefined;
    expect(
      filter,
      "plane-wiring called planeRoles without an excludeFilter argument",
    ).toBeDefined();
    expect(hasExcludePatterns(filter as ReturnType<typeof compileEgressFilter>)).toBe(true);
    expect(
      isExcludedPath(filter as ReturnType<typeof compileEgressFilter>, "Private/journal.md"),
    ).toBe(true);
  });

  it("the roles object planeRoles RETURNED refuses an excluded declaration, with no guardGatewayRoles wrap in the picture", async () => {
    wireWith(["Private/**"]);
    const roles = spy.calls[0]?.roles;
    expect(
      roles,
      "planeRoles returned null — the gateway env is not configured for this test",
    ).not.toBeNull();
    await expect(
      roles?.judge({
        messages: [{ role: "user", content: "x" }],
        sourcePaths: ["Private/journal.md"],
      }),
    ).rejects.toBeInstanceOf(EgressViolationError);
  });

  it("control: a PUBLIC declaration through the same roles object reaches the transport", async () => {
    wireWith(["Private/**"]);
    const roles = spy.calls[0]?.roles;
    const res = await roles?.judge({
      messages: [{ role: "user", content: "x" }],
      sourcePaths: ["Public/note.md"],
    });
    expect(res?.text).toBe("ok");
  });

  it("with no exclusion configured the wiring still builds a real port — the declaration requirement is unconditional", async () => {
    wireWith([]);
    const roles = spy.calls[0]?.roles;
    expect(spy.calls[0]?.args[2]).toBeDefined();
    await expect(
      roles?.judge({ messages: [{ role: "user", content: "x" }] } as Parameters<
        NonNullable<typeof roles>["judge"]
      >[0]),
    ).rejects.toBeInstanceOf(EgressViolationError);
  });
});
