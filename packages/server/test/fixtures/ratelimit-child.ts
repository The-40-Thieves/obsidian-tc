// Child process for the multi-process rate-limit test: opens the shared sqlite bucket store on its
// own connection (under Bun, so bun:sqlite; the parent is Node) and races the other processes for
// tokens at a frozen clock. Prints the number of tokens it won.
import { openSqliteBackend } from "../../src/ratelimit/sqlite-backend";

const [cacheDir, attempts] = process.argv.slice(2) as [string, string];
const backend = await openSqliteBackend({ cacheDir, db: { busyTimeoutMs: 10_000 } });
const spec = { capacity: 50, refillTokens: 10, intervalMs: 60_000 };
let won = 0;
for (let i = 0; i < Number(attempts); i++) {
  if ((await backend.consume("race", spec, 1, 0)).ok) won++;
}
await backend.close();
console.log(`WON ${won}`);
