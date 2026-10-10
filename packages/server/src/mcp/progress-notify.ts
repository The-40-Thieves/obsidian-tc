// `ctx.progress` for a request that sent a `progressToken`: each report becomes a
// `notifications/progress` on that request. Clients reset their per-request timeout on these (Claude
// Code gives up after five minutes without one), so a long tool reports whenever it is asked to.
import type { JobProgress } from "../scheduler/job-queue";

type SendProgress = (notification: {
  method: "notifications/progress";
  params: { progressToken: string | number; progress: number; total?: number; message?: string };
}) => Promise<void>;

/**
 * Returns `undefined` when the caller sent no token: an unsolicited progress notification names a
 * token the client never issued, and a tool given no hook builds no payload for nobody.
 *
 * The MCP rule is that `progress` increases with every notification, so a report that does not
 * advance is dropped here rather than in each tool. Fire-and-forget: the hook is called from inside
 * batch loops and must never make one wait on a client, and a send that fails (the request already
 * ended, the transport closed) is not the tool's problem.
 */
export function progressReporter(
  token: string | number | undefined,
  send: SendProgress,
): ((p: JobProgress) => void) | undefined {
  if (token === undefined) return undefined;
  let last = Number.NEGATIVE_INFINITY;
  return (p) => {
    if (!(p.progress > last)) return;
    last = p.progress;
    void send({
      method: "notifications/progress",
      params: {
        progressToken: token,
        progress: p.progress,
        ...(p.total !== undefined ? { total: p.total } : {}),
        ...(p.message !== undefined ? { message: p.message } : {}),
      },
    }).catch(() => undefined);
  };
}
