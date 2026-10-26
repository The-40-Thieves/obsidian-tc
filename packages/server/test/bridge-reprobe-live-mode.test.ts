// A companion that failed its boot probe must not stay degraded until a manual refresh.
//
// Two defects compounded: the per-vault mode was resolved ONCE from the boot snapshot, so a
// refresh that found the companion reachable still left assertLive refusing every Tier-3 tool;
// and nothing re-probed a failed vault in the background. These tests drive both paths through
// the real wireBridges wiring, with a controllable companion transport in place of the network.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeFetch } from "../src/bridge";
import { type FakeRoute, fakeBridgeTransport } from "../src/bridge/fake";
import {
  BRIDGE_REPROBE_INTERVAL_MS,
  registerBridgeReprobe,
  wireBridges,
} from "../src/runtime/bridge-wiring";
import { Scheduler } from "../src/scheduler/scheduler";
import { openBridge } from "../src/tools/m4/shared";

const BASE = "http://127.0.0.1:27124";
const PROBE = "GET /obsidian-tc/v1/probe";
const API_KEY = "sekrit-token-123";

const UNREACHABLE: FakeRoute = { networkError: true };
const REACHABLE: FakeRoute = {
  body: {
    ok: true,
    result: {
      plugin_version: "1.0.0",
      obsidianTcApiVersion: "1",
      capabilities: { dataview: { installed: true, version: "0.5.66" } },
    },
  },
};

/** Boot wireBridges for one auto-mode vault whose companion answers `route`. The transport reads
 *  `state.route` on every request, so a test flips the companion without rebuilding the wiring. */
async function boot(route: FakeRoute) {
  const state = { route, probes: 0 };
  const fetchFn: BridgeFetch = (input, init) => {
    state.probes++;
    return fakeBridgeTransport({ routes: { [PROBE]: state.route } })(input, init);
  };
  const bridges = await wireBridges({
    vaults: [{ id: "main", restApiUrl: BASE, restApiKey: API_KEY, mode: "auto" }] as never,
    vaultRegistry: {} as never,
    reindex: () => {},
    fetchFn,
  });
  return { bridges, state };
}

function reprobeScheduler(bridges: Awaited<ReturnType<typeof boot>>["bridges"]): Scheduler {
  const sched = new Scheduler({ now: () => 0 });
  registerBridgeReprobe(sched, {
    capabilities: bridges.capabilities,
    reprobe: bridges.reprobeVault,
    vaultIds: [...bridges.bridgeClients.keys()],
  });
  return sched;
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("bridge live mode follows the companion probe", () => {
  it("a boot-unreachable companion turns live after the scheduled re-probe, with no manual refresh", async () => {
    const { bridges, state } = await boot(UNREACHABLE);
    expect(codeOf(() => openBridge(bridges.m4Deps, "main", "dataview"))).toBe(
      "requires_live_obsidian",
    );

    vi.useFakeTimers();
    const sched = reprobeScheduler(bridges);
    sched.start();
    state.route = REACHABLE;
    await vi.advanceTimersByTimeAsync(BRIDGE_REPROBE_INTERVAL_MS);

    expect(openBridge(bridges.m4Deps, "main", "dataview").client).toBeDefined();
    await sched.stop();
  });

  it("a manual refresh that finds the companion reachable clears the Tier-3 live gate, independent of the scheduler", async () => {
    const { bridges, state } = await boot(UNREACHABLE);
    expect(codeOf(() => openBridge(bridges.m4Deps, "main", "dataview"))).toBe(
      "requires_live_obsidian",
    );

    // What refresh_plugin_capabilities does: re-probe, then swap the cached snapshot.
    state.route = REACHABLE;
    bridges.capabilities.set("main", await bridges.reprobeVault("main"));

    expect(openBridge(bridges.m4Deps, "main", "dataview").client).toBeDefined();
  });

  it("the re-probe stays idle while reachable, is unref'd, and stops on teardown", async () => {
    const { bridges, state } = await boot(REACHABLE);
    const probesAfterBoot = state.probes;

    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const sched = reprobeScheduler(bridges);
    sched.start();
    const schedulerTimer = setTimeoutSpy.mock.results.at(-1)?.value as { hasRef?: () => boolean };
    expect(schedulerTimer.hasRef?.()).toBe(false);

    await vi.advanceTimersByTimeAsync(5 * BRIDGE_REPROBE_INTERVAL_MS);
    expect(state.probes).toBe(probesAfterBoot);

    // Teardown: a companion that goes down after boot is re-probed until the scheduler stops.
    state.route = UNREACHABLE;
    await vi.advanceTimersByTimeAsync(BRIDGE_REPROBE_INTERVAL_MS);
    await sched.stop();
    const probesAtStop = state.probes;
    await vi.advanceTimersByTimeAsync(3 * BRIDGE_REPROBE_INTERVAL_MS);
    expect(state.probes).toBe(probesAtStop);
  });

  it("a failed boot probe logs its cause code and no credentials", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await boot(UNREACHABLE);
    const logged = write.mock.calls.map((c) => String(c[0])).join("");
    expect(logged).toContain('vault "main"');
    expect(logged).toContain("unreachable");
    expect(logged).not.toContain(API_KEY);
    expect(logged).not.toContain(BASE);
  });
});
