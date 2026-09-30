// Multi-instance backend: one Redis shared by every server instance. The bucket update is a single
// Lua script, so refill + take is atomic on the Redis server no matter how many instances race.
//
// The client (`@redis/client`, the official node-redis core) is an OPTIONAL dependency, imported
// lazily here and only when `throttle.backend` is "redis" — a zero-config install never loads it.
// It speaks plain sockets, so it runs under both Node and Bun (Bun.redis alone would not run under
// Node, and the server ships through npm). `defineScript` gives EVALSHA with an automatic EVAL
// fallback on NOSCRIPT, so a Redis restart or failover that flushed the script cache heals itself.
//
// The URL carries credentials. It is resolved from an env var or a file (never inline in config),
// handed to the client, and never written to a log or error: see redactUrlCredentials (backend.ts).
import { err } from "@the-40-thieves/obsidian-tc-shared";
import {
  type BucketSpec,
  fullRefillMs,
  type RateLimitBackend,
  redactUrlCredentials,
} from "./backend";
import type { TokenBucketResult } from "./bucket";

// Mirrors takeFromBucket (bucket.ts) line for line; the conformance suite's differential case fails
// if the two drift. State is a hash {t: tokens (17 significant digits, exact round trip), l: last ms}.
// KEYS[1] = bucket key; ARGV = capacity, refillTokens, intervalMs, n, nowMs, ttlMs.
const TAKE_TOKENS_LUA = `
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2]) / tonumber(ARGV[3])
local n = tonumber(ARGV[4])
local now = tonumber(ARGV[5])
local h = redis.call('HMGET', KEYS[1], 't', 'l')
local tokens = tonumber(h[1])
local last = tonumber(h[2])
if tokens == nil or last == nil then
  tokens = capacity
  last = now
else
  local elapsed = now - last
  if elapsed > 0 then
    tokens = math.min(capacity, tokens + elapsed * rate)
    last = now
  end
end
local ok = 0
local retry = 0
if tokens >= n then
  tokens = tokens - n
  ok = 1
else
  if rate > 0 then retry = math.ceil((n - tokens) / rate) else retry = -1 end
end
redis.call('HSET', KEYS[1], 't', string.format('%.17g', tokens), 'l', string.format('%.17g', last))
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[6]))
return { ok, retry, math.floor(tokens) }
`;

const MIN_TTL_MS = 60_000;

/** Minimal shape of the parts of a node-redis client this backend uses. */
interface RedisClientLike {
  connect(): Promise<unknown>;
  destroy(): void;
  on(event: "error", listener: (e: unknown) => void): unknown;
  takeTokens(
    key: string,
    capacity: string,
    refillTokens: string,
    intervalMs: string,
    n: string,
    nowMs: string,
    ttlMs: string,
  ): Promise<unknown>;
}

interface RedisModuleLike {
  createClient(opts: Record<string, unknown>): RedisClientLike;
  defineScript(script: Record<string, unknown>): unknown;
}

/** Load the optional client, or refuse with the exact remedy. Called once at backend creation so a
 *  missing package fails boot, not the first governed call. */
async function loadRedisModule(): Promise<RedisModuleLike> {
  try {
    return (await import("@redis/client")) as unknown as RedisModuleLike;
  } catch (cause) {
    throw err.invalidInput('throttle.backend "redis" needs the optional package @redis/client', {
      hint: 'install it next to obsidian-tc (`npm install @redis/client`), or set throttle.backend to "memory" or "sqlite".',
      cause: redactUrlCredentials(cause instanceof Error ? cause.message : String(cause)),
    });
  }
}

export interface RedisBackendOptions {
  /** Full connection URL (`redis://[user:password@]host:port[/db]`, or `rediss://` for TLS). */
  url: string;
  /** Prepended to every bucket key, so several deployments can share one Redis. */
  keyPrefix: string;
  /** Per-command deadline (default 500 ms). A slow Redis must not stall every tool call. */
  commandTimeoutMs?: number;
  /** TCP connect deadline (default 1000 ms). */
  connectTimeoutMs?: number;
}

export class RedisBackend implements RateLimitBackend {
  readonly kind = "redis" as const;
  private client: RedisClientLike | undefined;
  private connecting: Promise<RedisClientLike> | undefined;
  private closed = false;
  private readonly commandTimeoutMs: number;

  private constructor(
    private readonly mod: RedisModuleLike,
    private readonly opts: RedisBackendOptions,
  ) {
    this.commandTimeoutMs = opts.commandTimeoutMs ?? 500;
  }

  /** Loads the client package now (boot-time refusal if absent); connects lazily on first use. */
  static async create(opts: RedisBackendOptions): Promise<RedisBackend> {
    return new RedisBackend(await loadRedisModule(), opts);
  }

  private connect(): Promise<RedisClientLike> {
    if (this.client) return Promise.resolve(this.client);
    this.connecting ??= (async () => {
      let everConnected = false;
      const client = this.mod.createClient({
        url: this.opts.url,
        // A command issued while disconnected fails at once instead of queueing behind a dead
        // socket; the limiter's failure policy decides what that means for the call.
        disableOfflineQueue: true,
        scripts: {
          takeTokens: this.mod.defineScript({
            NUMBER_OF_KEYS: 1,
            SCRIPT: TAKE_TOKENS_LUA,
            parseCommand(
              parser: { pushKey(k: string): void; push(...a: string[]): void },
              key: string,
              ...args: string[]
            ) {
              parser.pushKey(key);
              parser.push(...args);
            },
            transformReply: undefined,
          }),
        },
        socket: {
          connectTimeout: this.opts.connectTimeoutMs ?? 1000,
          // Never connected: fail the connect() promise instead of retrying inside it forever (the
          // caller retries on its own schedule). Connected once: reconnect with capped backoff.
          reconnectStrategy: (retries: number, cause: Error) =>
            everConnected ? Math.min(50 * 2 ** retries, 2000) : cause,
        },
      });
      // node-redis emits 'error' for socket failures and throws if nobody listens; every real failure
      // also rejects the command that hit it, which is where the limiter reads it.
      client.on("error", () => {});
      try {
        await client.connect();
      } catch (e) {
        client.destroy();
        throw e;
      }
      everConnected = true;
      this.client = client;
      return client;
    })().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  async consume(
    key: string,
    spec: BucketSpec,
    n: number,
    nowMs: number,
  ): Promise<TokenBucketResult> {
    if (this.closed) throw new Error("rate-limit redis backend is closed");
    const ttlMs = Math.max(2 * fullRefillMs(spec), MIN_TTL_MS);
    const call = async (): Promise<unknown> => {
      const client = await this.connect();
      return client.takeTokens(
        this.opts.keyPrefix + key,
        String(spec.capacity),
        String(spec.refillTokens),
        String(spec.intervalMs),
        String(n),
        String(nowMs),
        String(ttlMs),
      );
    };
    const reply = await withDeadline(call(), this.commandTimeoutMs);
    if (!Array.isArray(reply) || reply.length !== 3) {
      throw new Error("unexpected reply from the rate-limit script");
    }
    const [ok, retry, tokens] = reply.map(Number) as [number, number, number];
    return {
      ok: ok === 1,
      retryAfterMs: retry < 0 ? Number.POSITIVE_INFINITY : retry,
      tokens,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    const client = this.client;
    this.client = undefined;
    client?.destroy();
  }
}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`redis command timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}
