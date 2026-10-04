// Child process for server-secret-followups.test.ts: announces it is ready, waits for the parent's
// go file so every racer reaches `serverSecret` together (a file barrier, not a clock one: spawn
// cost varies wildly across runners), then prints the key it returned.
//
// Optional third argument, JSON: `staleMs` shrinks the repair lock's stale threshold, and
// `stallUntil` is a file path: once the child holds the repair lock it freezes there until that
// file appears, standing in for a live holder that was descheduled past the stale threshold.
import { existsSync } from "node:fs";
import { serverSecret } from "../src/auth/server-secret";

const [cacheDir, goFile, optsJson] = process.argv.slice(2);
const cfg = JSON.parse(optsJson ?? "{}") as { staleMs?: number; stallUntil?: string };
process.stdout.write("ready\n");
while (!existsSync(goFile as string)) {
  // spin: sub-millisecond alignment of the racers once the file appears
}
const stallUntil = cfg.stallUntil;
process.stdout.write(
  serverSecret(cacheDir as string, {
    ...(cfg.staleMs !== undefined ? { staleMs: cfg.staleMs } : {}),
    ...(stallUntil !== undefined
      ? {
          beforeRepair: () => {
            while (!existsSync(stallUntil)) {
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
            }
          },
        }
      : {}),
  }),
);
