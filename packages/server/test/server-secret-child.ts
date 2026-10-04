// Child process for server-secret-followups.test.ts: waits for a shared start instant so N
// processes reach `serverSecret` together, then prints the key it returned.
import { serverSecret } from "../src/auth/server-secret";

const [cacheDir, startAt] = process.argv.slice(2);
while (Date.now() < Number(startAt)) {
  // spin: sub-millisecond alignment of the racers
}
process.stdout.write(serverSecret(cacheDir as string));
