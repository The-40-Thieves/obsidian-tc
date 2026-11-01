// GH #1433 rec 4, step 2: the child-process EmbedderHost, driven against the fake child fixture
// (test/fixtures/fake-embedder-child.mjs). No model loads and no signal is assumed: a child is
// stopped by the protocol's shutdown message or by child.kill().
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CIRCUIT_COOLDOWN_MS, createChildProcessHost } from "../src/embeddings/host/child-process";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-embedder-child.mjs", import.meta.url));
const INIT = { model: "fake", quantized: true, modelsRoot: "/unused", cacheDir: "/unused" };

let dir: string;
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "embedder-host-"));
  clock = 1_000_000;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function hostWith(env: Record<string, string>) {
  return createChildProcessHost({
    argv: [process.execPath, FIXTURE],
    init: INIT,
    env,
    now: () => clock,
    shutdownGraceMs: 2_000,
  });
}

async function until(condition: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition never held");
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
});
