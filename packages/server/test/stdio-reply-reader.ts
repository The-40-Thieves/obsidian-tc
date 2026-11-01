// Reply collection for a stdio server driven over in-memory streams: each JSON-RPC response, keyed by
// its request id. Shared by the stdio sessions.autoOpen tests so the line parser and the bounded wait
// live in one place.
import type { Readable } from "node:stream";
import { waitFor } from "./git-sync-test-helpers";

export type StdioReplies = Map<number, Record<string, any>>;

/** Starts collecting every response line the server writes to `stdout`. */
export function collectStdioReplies(stdout: Readable): StdioReplies {
  const replies: StdioReplies = new Map();
  let pending = "";
  stdout.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    for (let nl = pending.indexOf("\n"); nl >= 0; nl = pending.indexOf("\n")) {
      const msg = JSON.parse(pending.slice(0, nl));
      pending = pending.slice(nl + 1);
      if (typeof msg.id === "number") replies.set(msg.id, msg);
    }
  });
  return replies;
}

/** Waits up to 4 s for the reply to request `id`. A missing reply fails and names the method. */
export async function awaitStdioReply(
  replies: StdioReplies,
  id: number,
  method: string,
): Promise<Record<string, any>> {
  await waitFor(() => replies.has(id), 4_000).catch(() => {
    throw new Error(`no stdio reply for ${method}`);
  });
  return replies.get(id) as Record<string, any>;
}
