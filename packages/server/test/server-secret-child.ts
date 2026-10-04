// Child process for server-secret-followups.test.ts: announces it is ready, waits for the parent's
// go file so every racer reaches `serverSecret` together (a file barrier, not a clock one: spawn
// cost varies wildly across runners), then prints the key it returned.
import { existsSync } from "node:fs";
import { serverSecret } from "../src/auth/server-secret";

const [cacheDir, goFile] = process.argv.slice(2);
process.stdout.write("ready\n");
while (!existsSync(goFile as string)) {
  // spin: sub-millisecond alignment of the racers once the file appears
}
process.stdout.write(serverSecret(cacheDir as string));
