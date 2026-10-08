// Child process for server-secret-followups.test.ts: announces it is ready, waits for the parent's
// go file so every racer reaches `serverSecret` together (a file barrier, not a clock one: spawn
// cost varies wildly across runners), then prints the key it returned.
//
// Optional third argument, JSON: `staleMs` shrinks the repair lock's stale threshold. `stallUntil`,
// `stallBeforeMove` and `stallInGap` are file paths: the child freezes at that point of the repair
// (holding the lock, just before moving the key aside, or while it is moved aside) until the file
// appears, standing in for a live holder that was descheduled past the stale threshold.
import { existsSync } from "node:fs";
import { serverSecret } from "../src/auth/server-secret";

const [cacheDir, goFile, optsJson] = process.argv.slice(2);
const cfg = JSON.parse(optsJson ?? "{}") as {
  staleMs?: number;
  waitMs?: number;
  stallUntil?: string;
  stallBeforeMove?: string;
  stallInGap?: string;
};
process.stdout.write("ready\n");
while (!existsSync(goFile as string)) {
  // spin: sub-millisecond alignment of the racers once the file appears
}
const stallUntil = cfg.stallUntil;
const freezeUntil = (file: string) => () => {
  while (!existsSync(file)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
};
process.stdout.write(
  serverSecret(cacheDir as string, {
    ...(cfg.staleMs !== undefined ? { staleMs: cfg.staleMs } : {}),
    ...(cfg.waitMs !== undefined ? { waitMs: cfg.waitMs } : {}),
    ...(stallUntil !== undefined ? { beforeRepair: freezeUntil(stallUntil) } : {}),
    ...(cfg.stallBeforeMove !== undefined
      ? { beforeMoveAside: freezeUntil(cfg.stallBeforeMove) }
      : {}),
    ...(cfg.stallInGap !== undefined ? { inMoveGap: freezeUntil(cfg.stallInGap) } : {}),
  }),
);
