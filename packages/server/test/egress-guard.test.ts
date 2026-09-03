// THE-934 — the port-level defence-in-depth check. Pins: an excluded path in sourcePaths throws,
// an UNDECLARED sourcePaths (the field absent) throws, a DECLARED-empty sourcePaths (fix round 1,
// I1) passes — a prompt-budget truncation that dropped every candidate has real zero vault
// content and must not dead-letter — and a clean request reaches the wrapped client (asserted on
// the request PAYLOAD the wrapped client actually received, not a mock echo).
import { describe, expect, it } from "vitest";
import { compileEgressFilter } from "../src/plane/egress-filter";
import { EgressViolationError, guardGatewayRoles } from "../src/plane/egress-guard";
import type { GatewayCompletionRequest, GatewayRoles } from "../src/plane/gateway";

function countingRoles(): { roles: GatewayRoles; calls: GatewayCompletionRequest[] } {
  const calls: GatewayCompletionRequest[] = [];
  const respond = async (req: GatewayCompletionRequest) => {
    calls.push(req);
    return { text: "ok", model: "mock" };
  };
  return { roles: { extract: respond, synthesize: respond, judge: respond }, calls };
}

describe("egress guard (THE-934 defence-in-depth)", () => {
  it("refuses a request whose sourcePaths intersects the exclude filter", async () => {
    const { roles, calls } = countingRoles();
    const guarded = guardGatewayRoles(roles, compileEgressFilter(["Private/**"]));
    await expect(
      guarded.judge({
        messages: [{ role: "user", content: "x" }],
        sourcePaths: ["Public/a.md", "Private/secret.md"],
      }),
    ).rejects.toThrow(EgressViolationError);
    // The underlying client must never have been called — the guard sits BEFORE it.
    expect(calls).toHaveLength(0);
  });

  it("fix round 1 (I1): a DECLARED-empty sourcePaths passes — it is a real zero, not a missing declaration", async () => {
    const { roles, calls } = countingRoles();
    const guarded = guardGatewayRoles(roles, compileEgressFilter([]));
    const res = await guarded.synthesize({
      messages: [{ role: "user", content: "x" }],
      sourcePaths: [],
    });
    expect(res).toEqual({ text: "ok", model: "mock" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sourcePaths).toEqual([]);
  });

  it("refuses a content-bearing request with NO sourcePaths field at all", async () => {
    const { roles, calls } = countingRoles();
    const guarded = guardGatewayRoles(roles, compileEgressFilter([]));
    await expect(guarded.extract({ messages: [{ role: "user", content: "x" }] })).rejects.toThrow(
      EgressViolationError,
    );
    expect(calls).toHaveLength(0);
  });

  it("a clean request passes through to the wrapped client, payload intact", async () => {
    const { roles, calls } = countingRoles();
    const guarded = guardGatewayRoles(roles, compileEgressFilter(["Private/**"]));
    const res = await guarded.judge({
      messages: [{ role: "user", content: "FRAGMENT A / FRAGMENT B" }],
      sourcePaths: ["Public/a.md", "Public/b.md"],
    });
    expect(res).toEqual({ text: "ok", model: "mock" });
    // Assert on the request the wrapped client actually received, not on a mock echo.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sourcePaths).toEqual(["Public/a.md", "Public/b.md"]);
    expect(calls[0]?.messages[0]?.content).toBe("FRAGMENT A / FRAGMENT B");
  });
});
