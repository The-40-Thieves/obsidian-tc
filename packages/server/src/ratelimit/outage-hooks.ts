// What an operator sees when the shared bucket store goes away and comes back. RateLimiter fires
// these ONCE per outage (never per request); the message is redacted because a connection error can
// echo the URL, and the Redis URL carries the password.
import { type RateLimitFailurePolicy, redactUrlCredentials } from "./backend";

interface OutageMetrics {
  incRateLimitBackendOutage(backend: string): void;
}

export function outageHooks(
  metrics: OutageMetrics,
  log: (line: string) => void = (line) => console.error(line),
): {
  onBackendDown: (info: {
    backend: string;
    policy: RateLimitFailurePolicy;
    error: unknown;
  }) => void;
  onBackendUp: (info: { backend: string }) => void;
} {
  return {
    onBackendDown: ({ backend, policy, error }) => {
      metrics.incRateLimitBackendOutage(backend);
      const meaning =
        policy === "fail-open"
          ? "limits are enforced per process until it recovers"
          : "governed calls are refused as throttled until it recovers";
      const why = redactUrlCredentials(error instanceof Error ? error.message : String(error));
      log(`rate-limit backend "${backend}" is unreachable (${policy}: ${meaning}): ${why}`);
    },
    onBackendUp: ({ backend }) => {
      log(`rate-limit backend "${backend}" recovered; limits are shared again`);
    },
  };
}
