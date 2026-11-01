// GH #1433 rec 4, step 2: the child-process EmbedderHost, driven against the fake child fixture
// (test/fixtures/fake-embedder-child.mjs). No model loads and no signal is assumed: a child is
// stopped by the protocol's shutdown message or by child.kill().
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CIRCUIT_COOLDOWN_MS,
  CIRCUIT_WINDOW_MS,
  createChildProcessHost,
} from "../src/embeddings/host/child-process";
import { markCliEntry } from "../src/embeddings/host/spawn-argv";
import { stallTimeout } from "./stall-timeouts";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-embedder-child.mjs", import.meta.url));
const ONE_SHOT = fileURLToPath(new URL("./fixtures/embed-once-no-close.ts", import.meta.url));
const INIT = { model: "fake", quantized: true, modelsRoot: "/unused", cacheDir: "/unused" };

let dir: string;
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "embedder-host-"));
  clock = 1_000_000;
  // The CLI entry marks itself before any host spawns; the fixture stands in for it here.
  markCliEntry();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function hostWith(env: Record<string, string>, extra: { timeoutMs?: number } = {}) {
  return createChildProcessHost({
    argv: [process.execPath, FIXTURE],
    init: INIT,
    env,
    now: () => clock,
    shutdownGraceMs: 2_000,
    ...extra,
  });
}

async function until(condition: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition never held");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("child-process EmbedderHost", () => {
  it("spawns nothing at construction, and 3 embeds run in one child", async () => {
    const host = hostWith({});
    expect((await host.stats()).pid).toBeUndefined();
    expect(await host.embed(["a"])).toEqual([[1, 1, 0]]);
    const pid = (await host.stats()).pid;
    expect(pid).toBeDefined();
    expect(await host.embed(["bb", "ccc"])).toEqual([
      [2, 1, 0],
      [3, 1, 0],
    ]);
    expect(await host.embed(["dddd"])).toEqual([[4, 1, 0]]);
    expect((await host.stats()).pid).toBe(pid);
    expect((await host.stats()).restarts).toBe(0);
    await host.close();
  });

  it("recycle with a request in flight resolves that request, and the next embed runs in a NEW child", async () => {
    const host = hostWith({ FAKE_EMBED_DELAY_MS: "300" });
    const inFlight = host.embed(["a"]);
    await until(async () => (await host.stats()).state === "ready");
    const oldPid = (await host.stats()).pid;
    const draining = host.recycle("manual");
    const queued = host.embed(["bbb"]);
    expect(await inFlight).toEqual([[1, 1, 0]]);
    await draining;
    expect(await queued).toEqual([[3, 1, 0]]);
    const newPid = (await host.stats()).pid;
    expect(newPid).toBeDefined();
    expect(newPid).not.toBe(oldPid);
    expect((await host.stats()).recycles).toBe(1);
    await host.close();
  });

  it("a recycled child's RSS is no longer reported, so a drained host has no RSS to add to the budget", async () => {
    const host = hostWith({});
    await host.embed(["a"]);
    expect((await host.stats()).rssBytes).toBeGreaterThan(0);
    await host.recycle("reconcile");
    expect(host.snapshot().rssBytes).toBeUndefined();
    expect((await host.stats()).rssBytes).toBeUndefined();
    await host.close();
  });

  it("a child that dies on its first embed is replaced and the request succeeds on a retry", async () => {
    const host = hostWith({ FAKE_CRASH: "once", FAKE_CRASH_MARKER: join(dir, "crashed") });
    expect(await host.embed(["a"])).toEqual([[1, 1, 0]]);
    expect((await host.stats()).restarts).toBe(1);
    await host.close();
  });

  it("a child that dies on every embed rejects the request, and the circuit opens after 3 deaths", async () => {
    const host = hostWith({ FAKE_CRASH: "always" });
    // Each request is sent to a fresh child and retried once: two deaths, then a rejection.
    await expect(host.embed(["a"])).rejects.toMatchObject({ code: "embedding_provider_error" });
    // The third death opens the circuit, so this request is not retried.
    await expect(host.embed(["b"])).rejects.toMatchObject({ code: "embedding_provider_error" });
    expect((await host.stats()).state).toBe("failed");
    const deathsAtOpen = (await host.stats()).restarts;
    expect(deathsAtOpen).toBe(3);
    // While open, embeds are rejected without spawning.
    await expect(host.embed(["c"])).rejects.toMatchObject({ code: "embedding_provider_error" });
    expect((await host.stats()).restarts).toBe(deathsAtOpen);
    // After the cooldown one spawn is allowed; a death there re-opens the circuit.
    clock += CIRCUIT_COOLDOWN_MS;
    await expect(host.embed(["d"])).rejects.toMatchObject({ code: "embedding_provider_error" });
    expect((await host.stats()).state).toBe("failed");
  });

  it("close rejects queued requests, lets the in-flight one finish, and never respawns", async () => {
    const host = hostWith({ FAKE_EMBED_DELAY_MS: "200" });
    const inFlight = host.embed(["a"]);
    const queued = host.embed(["bb"]);
    await until(async () => (await host.stats()).state === "ready");
    const closing = host.close();
    await expect(queued).rejects.toThrow(/embedder host closed/);
    expect(await inFlight).toEqual([[1, 1, 0]]);
    await closing;
    await expect(host.embed(["c"])).rejects.toThrow(/embedder host closed/);
    expect((await host.stats()).pid).toBeUndefined();
  });

  // Fix round (Opus review, HIGH 1): an idle child must not hold the parent's event loop, or every
  // one-shot CLI command that embeds once and never closes the host hangs until killed.
  it("a one-shot host that embeds once and never closes lets the process exit on its own", () => {
    const run = spawnSync("bun", [ONE_SHOT, FIXTURE], {
      encoding: "utf8",
      timeout: stallTimeout(8_000),
    });
    expect(run.error).toBeUndefined();
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("[[3,1,0]]");
  });

  // Fix round (MEDIUM 2): close() with a request in flight starts the grace timer at once, so a
  // child that never finishes is killed and the in-flight request rejects instead of waiting.
  it("close() with a request in flight kills the child within the grace period, and the request rejects", async () => {
    const host = hostWith({ FAKE_EMBED_DELAY_MS: "20000" });
    const inFlight = host.embed(["a"]).then(
      () => "resolved",
      (error: { code?: string }) => error.code,
    );
    await until(async () => (await host.stats()).state === "ready");
    const pid = (await host.stats()).pid as number;
    const started = Date.now();
    const closing = host.close();
    expect(await inFlight).toBe("embedding_provider_error");
    await closing;
    expect(Date.now() - started).toBeLessThan(2_000 + 1_000);
    expect(alive(pid)).toBe(false);
  });

  // Fix round (MEDIUM 3): a child that never answers must not leave the request pending forever.
  it("a child that never answers an embed is killed at the request deadline, and the request rejects", async () => {
    const host = hostWith({ FAKE_HANG: "embed" }, { timeoutMs: 300 });
    await expect(host.embed(["a"])).rejects.toMatchObject({ code: "embedding_provider_error" });
    // Each death is retried once on a fresh child, like any other death.
    expect((await host.stats()).restarts).toBe(2);
    await host.close();
  });

  it("a child that never sends ready is killed at the ready deadline", async () => {
    const host = hostWith({ FAKE_HANG: "ready" }, { timeoutMs: 300 });
    await expect(host.embed(["a"])).rejects.toMatchObject({ code: "embedding_provider_error" });
    expect((await host.stats()).restarts).toBe(2);
    await host.close();
  });

  // Fix round (MEDIUM 4): a host only re-runs the program that marked itself as the CLI entry. A
  // program that embeds dist/index.js, or an eval script, must not turn into a fork chain.
  it("refuses to spawn a child unless the CLI entry marked itself, with embedding_provider_error", async () => {
    vi.resetModules();
    const fresh = await import("../src/embeddings/host/child-process");
    const host = fresh.createChildProcessHost({ argv: [process.execPath, FIXTURE], init: INIT });
    await expect(host.embed(["a"])).rejects.toMatchObject({ code: "embedding_provider_error" });
    expect((await host.stats()).pid).toBeUndefined();
  });

  // Fix round (MEDIUM 7): deaths expire from the sliding window, so a death an hour ago does not
  // count toward the three that open the circuit.
  it("deaths age out of the 60 s window, so an old death does not open the circuit", async () => {
    const host = hostWith({ FAKE_CRASH: "always" });
    await expect(host.embed(["a"])).rejects.toMatchObject({ code: "embedding_provider_error" });
    clock += CIRCUIT_WINDOW_MS + 1;
    await expect(host.embed(["b"])).rejects.toMatchObject({ code: "embedding_provider_error" });
    expect((await host.stats()).state).not.toBe("failed");
    await host.close();
  });

  // Fix round (MEDIUM 7): a successful reply does not reset the death count, so a batch that kills
  // its child every time it is tried cannot be hidden by healthy batches in between.
  it("a recurring poison batch opens the circuit even when healthy batches succeed in between", async () => {
    const host = hostWith({ FAKE_CRASH_TEXT: "poison" });
    await expect(host.embed(["poison"])).rejects.toMatchObject({
      code: "embedding_provider_error",
    });
    expect(await host.embed(["ok"])).toEqual([[2, 1, 0]]);
    await expect(host.embed(["poison"])).rejects.toMatchObject({
      code: "embedding_provider_error",
    });
    expect((await host.stats()).state).toBe("failed");
    await host.close();
  });

  // Fix round (MEDIUM 7): after the cooldown, one probe that succeeds closes the circuit.
  it("the circuit closes after a successful probe once the cooldown has passed", async () => {
    const host = hostWith({ FAKE_CRASH: "until-marker", FAKE_CRASH_MARKER: join(dir, "healthy") });
    await expect(host.embed(["a"])).rejects.toMatchObject({ code: "embedding_provider_error" });
    await expect(host.embed(["b"])).rejects.toMatchObject({ code: "embedding_provider_error" });
    expect((await host.stats()).state).toBe("failed");
    writeFileSync(join(dir, "healthy"), "ok\n");
    clock += CIRCUIT_COOLDOWN_MS;
    expect(await host.embed(["ccc"])).toEqual([[3, 1, 0]]);
    expect((await host.stats()).state).toBe("ready");
    expect(await host.embed(["dd"])).toEqual([[2, 1, 0]]);
    await host.close();
  });
});
