// THE-634 — the proactive-advisory push channel: a second private extension over
// `subscriptions/listen`, alongside the Tasks extension (mcp/tasks.ts), for exactly the reason
// documented there. The SDK's own listen handler is closed over a strict four-key
// SubscriptionFilter/ServerEvent union (toolsListChanged / promptsListChanged /
// resourcesListChanged / resourceSubscriptions), so neither an advisory opt-in nor an advisory
// event is expressible through it. Served in front of the SDK handler, same seam, same reason —
// see transports/http.ts, right beside where the Tasks extension is intercepted.
//
// MODERN-ERA ONLY, and that is a documented ceiling, not an oversight. `subscriptions/listen` is
// 2026-07-28-only (docs/MCP-COMPATIBILITY.md: the legacy row reads n/a). Production sits behind
// LiteLLM, pinned to `mcp` 1.28.1 (legacy ceiling 2025-11-25), so no advisory reaches it through
// this channel regardless of what the scheduler sweep (runtime/advisory-sweep.ts) produces.
// Closing that gap is explicitly OUT OF SCOPE for THE-634 — see the PR description — and this
// module is built to degrade to it rather than paper over it: publishing to a bus with no open
// stream for a given (vault, caller) throws nothing, blocks nothing, and delivers nothing. Silent
// AND documented, not silent and accidental.
//
// OWNERSHIP mirrors serveTaskSubscription exactly: a stream sees only advisories addressed to the
// SAME (vaultId, caller) that opened it. An advisory is per-session (the interrupt budget in
// advisory-policy.ts is per-session), so the event also carries sessionId for the client to key on.

/** One sweep's selection for one session, ready to cross the wire. Deliberately NOT `ScoredAdvisory`
 *  verbatim — the wire shape is a boundary a caller depends on, the internal type is not, and the
 *  two should be free to diverge (e.g. `ScoredAdvisory.candidate` is an internal detail this never
 *  needs to expose). */
export interface AdvisoryPushItem {
  /** `chunk_retrievals.chunk_id` for this advisory — what `record_retrieval_feedback` targets to
   *  stamp a dismissal. */
  chunkId: string;
  goalId: string;
  goalText: string;
  score: number;
  candidateKind: string;
}

export interface AdvisoryPushEvent {
  vaultId: string;
  /** The server-OBSERVED principal owning the session this was selected for (workspace_sessions
   *  .principal — see workspace/sessions.ts's own distinction from the caller-SUPPLIED `caller`
   *  column). Never null-matches: a stream opened by an unidentified caller never receives an
   *  event whose `caller` is also null, because `serveAdvisorySubscription`'s filter is `===`
   *  identity, not `IS`. */
  caller: string | null;
  sessionId: string;
  advisories: readonly AdvisoryPushItem[];
}

export interface AdvisoryBus {
  /** Best-effort. No open stream for this event's (vaultId, caller) is the common case — most
   *  sessions are legacy-era or simply not currently listening — and must be silent, never a
   *  throw. A single listener's own failure is caught so it cannot break delivery to any other. */
  publish(event: AdvisoryPushEvent): void;
  onAdvisory(listener: (event: AdvisoryPushEvent) => void): () => void;
}

/** One process-local pub/sub, matching JobQueue.onTaskChange's shape (scheduler/job-queue.ts) —
 *  a Set of listeners, never thrown into by a publish. */
export function createAdvisoryBus(): AdvisoryBus {
  const listeners = new Set<(event: AdvisoryPushEvent) => void>();
  return {
    publish(event) {
      if (listeners.size === 0) return;
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch {
          /* one subscriber's failure must not break delivery to another's stream */
        }
      }
    },
    onAdvisory(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * The subscription key a client uses to opt into advisory push.
 *
 * Namespaced under this repo's own reverse-DNS identifier rather than `io.modelcontextprotocol/*`
 * — unlike Tasks, there is no spec extension for this; it is a private one, and squatting the spec
 * namespace would misrepresent it as one.
 */
export const ADVISORY_SUBSCRIPTION_KEY = "io.the40thieves.obsidian-tc/advisory";

/** Did this `subscriptions/listen` ask for advisory push? */
export function subscribesToAdvisories(body: unknown): boolean {
  const params = (body as { params?: { notifications?: Record<string, unknown> } } | null)?.params;
  return params?.notifications?.[ADVISORY_SUBSCRIPTION_KEY] === true;
}

export interface AdvisoryStreamOwner {
  vaultId: string;
  caller: string | null;
}

/**
 * Serve the advisory push stream. Ack first (carrying the subscription id, exactly as the core
 * streams and the Tasks extension do), then one `notifications/advisory` frame per matching
 * publish for as long as the connection stays open.
 */
export function serveAdvisorySubscription(
  body: unknown,
  bus: AdvisoryBus,
  owner: AdvisoryStreamOwner,
  signal: AbortSignal,
): Response {
  const id = (body as { id?: string | number | null } | null)?.id ?? null;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (frame: Record<string, unknown>) => {
        try {
          controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(frame)}\n\n`));
        } catch {
          /* the client hung up between the check and the write */
        }
      };
      send({
        jsonrpc: "2.0",
        method: "notifications/subscriptions/acknowledged",
        params: {
          notifications: { [ADVISORY_SUBSCRIPTION_KEY]: true },
          _meta: { "io.modelcontextprotocol/subscriptionId": id },
        },
      });
      const unsubscribe = bus.onAdvisory((event) => {
        // OWNERSHIP, on every frame — the same discipline serveTaskSubscription applies to task
        // change events, applied here to advisory push.
        if (event.vaultId !== owner.vaultId) return;
        if (event.caller !== owner.caller) return;
        send({
          jsonrpc: "2.0",
          method: "notifications/advisory",
          params: { sessionId: event.sessionId, advisories: event.advisories },
        });
      });
      const close = () => {
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      if (signal.aborted) close();
      else signal.addEventListener("abort", close, { once: true });
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
