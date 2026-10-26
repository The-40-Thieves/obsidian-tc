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
  reprobeVaultIds,
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

/** Boot wireBridges for auto-mode vaults whose companion answers `route`. The transport reads
 *  `state.route` on every request, so a test flips the companion without rebuilding the wiring. */
async function boot(route: FakeRoute, ids: readonly string[] = ["main"]) {
  const state = { route, probes: 0 };
  const fetchFn: BridgeFetch = (input, init) => {
    state.probes++;
    return fakeBridgeTransport({ routes: { [PROBE]: state.route } })(input, init);
  };
  const bridges = await wireBridges({
    vaults: ids.map((id) => ({
      id,
      restApiUrl: BASE,
      restApiKey: API_KEY,
      mode: "auto",
    })) as never,
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
  vi.restoreAllMocks();
  vi.useRealTimers();
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

  it("a stale scheduled probe that finishes after a manual refresh does not overwrite it", async () => {
    const { bridges, state } = await boot(UNREACHABLE);

    // The tick's probe reads the unreachable companion, then hangs before it reports back.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.useFakeTimers();
    const sched = new Scheduler({ now: () => 0 });
    registerBridgeReprobe(sched, {
      capabilities: bridges.capabilities,
      reprobe: async (id) => {
        const snap = await bridges.reprobeVault(id);
        await gate;
        return snap;
      },
      vaultIds: ["main"],
    });
    sched.start();
    await vi.advanceTimersByTimeAsync(BRIDGE_REPROBE_INTERVAL_MS);

    // The companion comes up, and a manual refresh records it before the stale probe finishes.
    state.route = REACHABLE;
    bridges.capabilities.set("main", await bridges.reprobeVault("main"));
    release();
    await sched.stop();

    expect(bridges.capabilities.get("main").companion).toBe("reachable");
    expect(openBridge(bridges.m4Deps, "main", "dataview").client).toBeDefined();
  });

  it("stop() mid-tick starts no further vault probe", async () => {
    const { bridges } = await boot(UNREACHABLE, ["a", "b", "c"]);
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.useFakeTimers();
    const sched = new Scheduler({ now: () => 0 });
    registerBridgeReprobe(sched, {
      capabilities: bridges.capabilities,
      reprobe: async (id) => {
        started.push(id);
        await gate;
        return bridges.reprobeVault(id);
      },
      vaultIds: ["a", "b", "c"],
    });
    sched.start();
    await vi.advanceTimersByTimeAsync(BRIDGE_REPROBE_INTERVAL_MS);
    expect(started).toEqual(["a"]);

    const stopping = sched.stop();
    release();
    await stopping;
    expect(started).toEqual(["a"]);
  });

  it("the re-probe stays idle while reachable and is unref'd", async () => {
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
    await sched.stop();
  });

  it("stop() ends the re-probe of a companion that stays unreachable", async () => {
    const { bridges, state } = await boot(UNREACHABLE);

    vi.useFakeTimers();
    const sched = reprobeScheduler(bridges);
    sched.start();
    await vi.advanceTimersByTimeAsync(BRIDGE_REPROBE_INTERVAL_MS);
    expect(state.probes).toBeGreaterThan(1);

    await sched.stop();
    const probesAtStop = state.probes;
    await vi.advanceTimersByTimeAsync(3 * BRIDGE_REPROBE_INTERVAL_MS);
    expect(state.probes).toBe(probesAtStop);
  });

  it("registers no re-probe job for a headless-pinned vault or a vault without a bridge", async () => {
    const { bridges } = await boot(UNREACHABLE, ["pinned", "auto"]);
    const vaults = [
      { id: "pinned", mode: "headless" },
      { id: "auto", mode: "auto" },
      { id: "plain", mode: "auto" },
    ];
    const bridged = new Map([
      ["pinned", bridges.bridgeClients.get("pinned")],
      ["auto", bridges.bridgeClients.get("auto")],
    ]);
    expect(reprobeVaultIds(vaults, bridged)).toEqual(["auto"]);

    const sched = new Scheduler({ now: () => 0 });
    registerBridgeReprobe(sched, {
      capabilities: bridges.capabilities,
      reprobe: bridges.reprobeVault,
      vaultIds: reprobeVaultIds(vaults.slice(0, 1), new Map()),
    });
    expect(sched.stats()).toEqual([]);
  });

  it("a failed boot probe logs its cause code and no credentials", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await boot(UNREACHABLE);
    const logged = write.mock.calls.map((c) => String(c[0])).join("");
    expect(logged).toContain('vault "main"');
    expect(logged).toContain("unreachable");
    expect(logged).toContain("(ECONNREFUSED)");
    expect(logged).not.toContain(API_KEY);
    expect(logged).not.toContain(API_KEY.slice(0, 4));
    expect(logged).not.toContain(BASE);
  });
});
