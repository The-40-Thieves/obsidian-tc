---
title: Rate-limit backends
description: Where rate-limit buckets live (memory, sqlite, redis), how to configure each, and what a governed call does when a shared backend is down.
---

Every governed call — every tool call and every resource read, after authentication, scope and
folder-ACL checks — draws one token from a bucket keyed by `(caller_hash, scope_class, vault_id)`.
The tiers (`throttle.tiers`) say how big a bucket is and how fast it refills; the **backend** says
where the buckets live. That decides whether two server processes, or two restarts, share one limit.

| `throttle.backend` | Buckets live in | Shared between | Survives restart | Extra dependency |
| --- | --- | --- | --- | --- |
| `memory` (default) | a process-local map | nothing | no | none |
| `sqlite` | `<cacheDir>/ratelimit.db` | every process using the same `cacheDir` (one host) | yes | none |
| `redis` | a Redis server | every instance pointing at that Redis | yes | optional `@redis/client` |

Zero configuration is unchanged: `memory` is the default, loads nothing extra and does no I/O.

## Why you might want a shared backend

`memory` limits each process on its own. Stdio MCP clients each spawn their own server process, so N
clients sharing one `cacheDir` get N times the configured limit, and a restart hands every caller a
full bucket again. `sqlite` closes both gaps on one host; `redis` closes them across hosts.

## `memory`

The behavior the server has always had. Idle buckets are reclaimed once they are guaranteed full, so
eviction can never grant extra burst.

## `sqlite`

```json
{ "throttle": { "backend": "sqlite" } }
```

Each governed call runs one `BEGIN IMMEDIATE` transaction that reads the bucket, refills it, takes
the token and writes it back, so two processes can never spend the same token. A contended update
waits at most `db.busyTimeoutMs` (default 5000) before it fails, and the failure policy below
decides the call.

The buckets get their **own file**, `ratelimit.db`, not `cache.db`. A bucket update is a write
transaction per call, and the buckets are ephemeral, so sharing `cache.db` would queue every tool
call behind the indexer's long write transactions. Measured with a second process holding 20 ms
write transactions on the same file, the mean cost of one bucket update rose from 97 µs (dedicated
file) to 836 µs, with a 235 ms worst-case tail; the dedicated file only ever contends with its own
tiny transactions. The file works under both Bun (`bun:sqlite`) and Node (`better-sqlite3`, or
`node:sqlite` when that is unavailable), the same split as `cache.db`, and Bun and Node processes
can share one file.

`ratelimit.db` is disposable. Deleting it while no server is running only hands every caller a
full bucket.

## `redis`

```json
{
  "throttle": {
    "backend": "redis",
    "redis": { "urlEnv": "OBSIDIAN_TC_REDIS_URL", "keyPrefix": "obsidian-tc:rl:" }
  }
}
```

```bash
export OBSIDIAN_TC_REDIS_URL='redis://default:<password>@redis.internal:6379'   # rediss:// for TLS
npm install @redis/client        # npm installs only: optional dependency, loaded only when backend is "redis"
```

The bucket update is one Lua script, so refill-and-take is atomic on the Redis server however many
instances race. The script is sent with `EVALSHA` and re-sent automatically if the server's script
cache was flushed. Each bucket carries a TTL, so idle buckets vanish on their own. `keyPrefix` lets
several deployments share one Redis.

- **The URL carries the password, so config never holds it.** There is no inline `url` field.
  `redis.urlEnv` names the environment variable to read, and `redis.urlFile` (wins over `urlEnv`)
  points at a file whose content is the URL, for container secret mounts. The URL is never logged
  and is stripped from any connection error before it is printed.
- **Where the client must be resolvable.** `@redis/client` is an optional dependency kept out of the
  bundle, so each way of running the server treats `backend: "redis"` differently:

  | Install | Redis backend | Notes |
  | --- | --- | --- |
  | npm (`npm install obsidian-tc`) | supported | optional dependencies install by default; if yours are disabled, `npm install @redis/client` |
  | Container image (GHCR) | supported | the image ships the pinned `@redis/client` next to the bundle, nothing to install |
  | `.mcpb` desktop bundle | not supported | single-user, no `node_modules`: `backend: "redis"` refuses at startup with the install hint. Use `memory` or `sqlite` |

- **Boot refusal.** A missing URL, or a missing `@redis/client`, stops the server at startup with
  the exact remedy. An unreachable Redis at startup does **not**: that is an outage, handled by the
  failure policy.
- **Clocks.** Instances compare their own wall clocks against the timestamp stored in the bucket.
  A clock that runs behind never mints tokens (a clock that stands still or runs backwards refills
  nothing), but an instance whose clock runs *ahead* refills faster. Keep instances on NTP.
- The client speaks plain sockets, so it works under Node and Bun.

## Failure policy

`throttle.failurePolicy` decides what a governed call does while `sqlite` or `redis` cannot be
reached (Redis down, or SQLite locked beyond `db.busyTimeoutMs`). `memory` cannot fail.

| Value | During the outage | Choose it when |
| --- | --- | --- |
| `fail-open` (default) | the call is served; limits are enforced **per process** from local buckets | the limiter is abuse and cost control, which is what it is here |
| `fail-closed` | the call is refused as `throttled` with `details.reason: "backend_unavailable"` and a retry hint | you need a hard cluster-wide cap even at the price of availability |

**Why `fail-open` is the default.** The limiter sits *after* authentication, scope and folder-ACL
checks and, for destructive or HITL-floored calls, after the confirmation gate. No unauthenticated
request reaches a bucket, so it is not a brute-force or access-control boundary: it bounds the rate
of calls that are already authorized. Failing closed would let the death of a cache turn into an
outage of every tool for every client. `fail-open` does not lift the limit: each process falls back
to its own local buckets, so the worst case during an outage is N processes times the configured
limit, the same as `memory` today.

A refusal caused by the outage is not a rate-limit hit: it is not counted in
`obsidian_tc_rate_limit_hits_total`.

**Reporting.** The first failure of an outage logs one line to stderr and increments
`obsidian_tc_rate_limit_backend_outages_total{backend}` once; recovery logs one line. It is never
one line per request. While the backend is down it is probed at most once every 5 seconds, so an
outage costs one failed call per window instead of one per request.

## Overhead

One bucket update per governed call, measured with `packages/server/scripts/bench-ratelimit.ts`
(20 000 sequential calls over 1 000 keys, Redis on localhost, on a shared 4-core arm64 box under
load, so read the medians rather than the tails):

| Backend | Bun p50 | Node p50 |
| --- | --- | --- |
| memory | 0.4 µs | 0.7 µs |
| sqlite (`ratelimit.db`) | 21.5 µs | 23.6 µs |
| redis (localhost) | 320 µs | 307 µs |

A Redis on another host adds its network round trip to every governed call. The per-command
deadline is 500 ms, and a slow Redis counts as an outage.
