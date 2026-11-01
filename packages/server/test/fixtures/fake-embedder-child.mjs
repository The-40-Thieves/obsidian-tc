// A deterministic stand-in for the embedder child (embeddings/host/child-main.ts). It speaks the same
// NDJSON protocol (embeddings/host/protocol.ts) and returns vectors derived from the input, so the
// host's round trip, recycle and crash handling can be tested without loading a model.
//
// Env switches (all optional):
//   FAKE_CRASH=always            exit(3) on every embed request, before answering it.
//   FAKE_CRASH=once              exit(3) on the first embed request only: it creates FAKE_CRASH_MARKER
//                                and the next child sees the marker and answers normally.
//   FAKE_CRASH=until-marker      exit(3) on every embed request until FAKE_CRASH_MARKER exists.
//   FAKE_CRASH_TEXT=<text>       exit(3) on any embed request whose texts include <text>.
//   FAKE_EMBED_DELAY_MS=<n>      sleep before answering an embed (keeps a request in flight).
//   FAKE_HANG=embed|ready        never answer an embed, or never send ready (the host must time out).
import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const env = process.env;
const send = (msg) => process.stdout.write(`${JSON.stringify({ v: 1, ...msg })}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let queue = Promise.resolve();
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  queue = queue.then(() => handle(JSON.parse(line)));
});
// The parent closing our stdin means the parent is gone: exit cleanly, the way child-main does.
rl.on("close", () => {
  queue.then(() => process.exit(0));
});

async function handle(msg) {
  switch (msg.t) {
    case "init":
      if (env.FAKE_HANG === "ready") return;
      send({ t: "ready", pid: process.pid });
      return;
    case "embed": {
      if (env.FAKE_HANG === "embed" || env.FAKE_HANG === "ready") return;
      if (env.FAKE_CRASH === "always") process.exit(3);
      if (env.FAKE_CRASH === "until-marker" && !existsSync(env.FAKE_CRASH_MARKER)) process.exit(3);
      if (env.FAKE_CRASH === "once" && !existsSync(env.FAKE_CRASH_MARKER)) {
        writeFileSync(env.FAKE_CRASH_MARKER, "crashed\n");
        process.exit(3);
      }
      if (env.FAKE_CRASH_TEXT && msg.texts.includes(env.FAKE_CRASH_TEXT)) process.exit(3);
      if (env.FAKE_EMBED_DELAY_MS) await sleep(Number(env.FAKE_EMBED_DELAY_MS));
      send({ t: "result", id: msg.id, vectors: msg.texts.map((text) => [text.length, 1, 0]) });
      return;
    }
    case "stats":
      send({ t: "stats", id: msg.id, rssBytes: process.memoryUsage().rss });
      return;
    case "shutdown":
      process.exit(0);
      return;
    default:
      process.stderr.write(`unknown message ${msg.t}\n`);
  }
}
