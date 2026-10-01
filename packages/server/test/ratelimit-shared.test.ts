// The point of the shared backends: limits that hold ACROSS handles, and across a restart.
import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { BucketSpec } from "../src/ratelimit/backend";
import { openSqliteBackend } from "../src/ratelimit/sqlite-backend";
import { RateLimiter } from "../src/throttle";
import { redisExistenceFloor, STORE_KINDS, type Store } from "./ratelimit-harness";
import { makeTempDir } from "./tmp";

redisExistenceFloor();

const SPEC: BucketSpec = { capacity: 3, refillTokens: 10, intervalMs: 60_000 };
const TIERS = { bulk: { perMinute: 10, burst: 3 } };

for (const sk of STORE_KINDS) {
  describe.skipIf(!sk.enabled)(`shared bucket state: ${sk.kind}`, () => {
    const stores: Store[] = [];
    afterEach(async () => {
      await Promise.allSettled(stores.splice(0).map((s) => s.cleanup()));
    });
    const newStore = async () => {
      const s = await sk.newStore();
      stores.push(s);
      return s;
    };

    if (sk.shared) {
      it("two handles see each other's consumption", async () => {
        const store = await newStore();
        const a = await store.open();
        const b = await store.open();
        expect((await a.consume("k", SPEC, 2, 0)).tokens).toBe(1);
        // b never touched the bucket, yet finds a's spend: one token left, not three.
        const first = await b.consume("k", SPEC, 1, 0);
        expect(first.ok).toBe(true);
        expect(first.tokens).toBe(0);
        expect((await a.consume("k", SPEC, 1, 0)).ok).toBe(false);
      });

      it("two RateLimiters over one store enforce ONE limit between them", async () => {
        const store = await newStore();
        const l1 = new RateLimiter(TIERS, { backend: await store.open() });
        const l2 = new RateLimiter(TIERS, { backend: await store.open() });
        const granted: boolean[] = [];
        for (let i = 0; i < 6; i++) {
          granted.push((await (i % 2 ? l1 : l2).check("c0ffee00", "bulk", "v1", 0)).ok);
        }
        expect(granted.filter(Boolean)).toHaveLength(3); // burst is 3 for the pair, not 3 each
      });

      it("buckets survive a restart (a fresh backend over the same store)", async () => {
        const store = await newStore();
        const before = new RateLimiter(TIERS, { backend: await store.open() });
        for (let i = 0; i < 3; i++) await before.check("c0ffee00", "bulk", "v1", 0);
        await before.close();
        const after = new RateLimiter(TIERS, { backend: await store.open() });
        const d = await after.check("c0ffee00", "bulk", "v1", 0);
        expect(d.ok).toBe(false); // the "restart resets buckets" gap, closed
      });
    } else {
      it("(memory) handles are independent and a restart resets buckets, as documented", async () => {
        const store = await newStore();
        const a = await store.open();
        const b = await store.open();
        for (let i = 0; i < 3; i++) await a.consume("k", SPEC, 1, 0);
        expect((await a.consume("k", SPEC, 1, 0)).ok).toBe(false);
        expect((await b.consume("k", SPEC, 1, 0)).ok).toBe(true);
      });
    }
  });
}

describe("sqlite: separate PROCESSES share one ratelimit.db", () => {
  const bun = spawnSync("bun", ["--version"], { encoding: "utf8" });
  const hasBun = bun.status === 0;
  if (!hasBun) {
    console.warn("[ratelimit] SKIPPING the multi-process sqlite test: `bun` is not on PATH.");
  }
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it.skipIf(!hasBun)(
    "three bun processes and this node process race for 50 tokens: exactly 50 are granted",
    async () => {
      dir = makeTempDir("otc-ratelimit-mp-");
      const child = fileURLToPath(new URL("./fixtures/ratelimit-child.ts", import.meta.url));
      const runChild = () =>
        new Promise<number>((resolve, reject) => {
          const p = spawn("bun", [child, dir, "40"], { stdio: ["ignore", "pipe", "pipe"] });
          let out = "";
          let errOut = "";
          p.stdout.on("data", (d) => {
            out += d;
          });
          p.stderr.on("data", (d) => {
            errOut += d;
          });
          p.on("error", reject);
          p.on("close", (code) => {
            const m = /WON (\d+)/.exec(out);
            if (code === 0 && m) resolve(Number(m[1]));
            else reject(new Error(`child exited ${code}: ${errOut || out}`));
          });
        });
      const children = [runChild(), runChild(), runChild()];
      // This process (Node adapter) competes on its own connection, 40 attempts like the children.
      const mine = await openSqliteBackend({ cacheDir: dir, db: { busyTimeoutMs: 10_000 } });
      const spec = { capacity: 50, refillTokens: 10, intervalMs: 60_000 };
      let won = 0;
      for (let i = 0; i < 40; i++) if ((await mine.consume("race", spec, 1, 0)).ok) won++;
      await mine.close();
      const total = won + (await Promise.all(children)).reduce((a, b) => a + b, 0);
      // 4 processes x 40 attempts = 160 attempts against 50 tokens: never more, never fewer.
      expect(total).toBe(50);
    },
    60_000,
  );
});
