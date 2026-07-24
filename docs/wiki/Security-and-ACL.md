# Security and ACL

obsidian-tc is **safe by default**. Five mechanisms guard every tool call — auth, ACL, the read-only kill switch, HITL confirmation, and idempotency + rate limiting — evaluated in the Auth, ACL, and Policy layers of the dispatch pipeline (see **[[Architecture]]**). Full design: [`docs/G2.4-security.md`](https://github.com/The-40-Thieves/obsidian-tc/blob/main/docs/G2.4-security.md).

## Authentication

Two modes: `none` and `jwt`. JWT accepts **HS256** (shared `jwtSecret`) or **asymmetric RS256 / ES256 / EdDSA** verified against a JWKS — inline `jwks` or a file-loaded `jwksFile`, with an `algorithms` allowlist and `kid`-based key rotation. HS256 verifies only against the secret and asymmetric algs only against the JWKS, so the alg-confusion attack is structurally impossible. Full OAuth token issuance / DCR stays out of scope, but the HTTP transport advertises RFC 9728 Protected Resource Metadata when `auth.resource` + `authorizationServers` are set. A bad signature, expired token, or missing claim returns `acl_denied` — the server does **not** distinguish a bad token from no access, to avoid information leak.

**Fail-closed interlock:** the config is refused at load when `transports.http.enabled && auth.mode === "none"` and the bind host is non-loopback. An unauthenticated server can never serve a routable host.

## Scopes and ACL

Scopes are op-on-path: `read:vault`, `write:vault/02-projects/**`, `delete:vault/...`, `execute:<plugin>`, `admin`. The **ACL layer** parses each tool's declarative annotation (e.g. `acl: write on path`), resolves the resource against the vault's `readPaths` / `writePaths` / `deletePaths` globs, and matches it against the caller's scopes. A path's `rules` scopes are additionally **required** of the caller to operate on that path (P1.4, last-match-wins) — enforced centrally at dispatch on tool operations; they do not filter search-result visibility (that is `readPaths`). The `inspect_acl` admin tool tests any `(vault, path, op, scopes)` tuple, including the path-required scopes.

The root `acl` is the inherited default; each `vaults[]` entry may carry its own `acl` block (same shape) to override it **per vault** — e.g. writable in vault A, read-only in vault B, enforced at dispatch in one process. Set `strictReadDefault: true` to make an undefined `readPaths` fail **closed** on reads.

The scope check fires in the **ACL layer only** — never scattered across the 146 tool impls — so adding a scope class is a single parser change.

Path enforcement is inode-aware: an in-vault symlink pointing outside the vault is rejected by realpath canonicalization, and a **hard-linked** file (`st_nlink > 1`) is rejected under a folder ACL (a hard link aliases an inode realpath cannot dereference). Reads run on the opened fd. The .obsidian/.git/.trash default-deny folds case, so a case-variant control-directory path cannot evade it on a case-insensitive filesystem (Windows/macOS).

## Kill switch

Global `acl.readOnly: true` short-circuits every write/delete to a `read_only_mode` error before dispatch. The fastest way to make a server safe.

## Human-in-the-loop (HITL)

Destructive or large operations require confirmation. A tripped tool returns an `elicit_required` error carrying an `elicit_token`; the client re-invokes the **same tool** with that token to proceed. Tokens are **single-use, 5-minute default TTL (configurable via `elicitTtlSeconds`), bound to `(vault, tool_name, args_hash, caller)`** — a token cannot authorize a different tool or different args, and replay returns `token_already_consumed`.

This is a custom token pattern, **not** MCP's native `elicitation` capability, so it works with any MCP client.

### Default thresholds (per-vault tunable)

| Condition | Default |
|---|---|
| `delete_attachment` with references | required if `reference_count > 0` |
| Bulk create / set-property | required if `count > 50` |
| Canvas node removal | required if removing `> 10` nodes |
| `move_attachment` references | required if `reference_count > 10` |
| `ocr_bulk` file count | required if `> 20` |
| Cross-folder copy / move | required when crossing a top-level folder boundary |
| Task `done → todo` flip | required if it was done `> 7` days ago |
| `write_note` overwrite | required when overwriting a non-empty existing file |
| `reset_vault_cache` | always required |

Humans can raise thresholds for lower friction; agent sandboxes can lower them for tighter safety. **Execute-family tools sit on a hardcoded HITL floor** — `git_commit`, command execution, and bulk-destructive paths always require confirmation regardless of configured thresholds.

## Write safety (compare-and-swap)

Every note write exposes a `prev_hash` (compare-and-swap): pass the hash you last read, and the write is rejected with `concurrent_modification` if the note changed underneath you. This covers `write_note` (overwrite), `append_note`, and `update_frontmatter` — defense-in-depth for multi-writer setups. Optional by default; set `writes.requireCas: true` to make it mandatory on the destructive paths, which then fail closed when `prev_hash` is absent.

## Idempotency

Write tools accept an `idempotency_key`. A replay within the TTL (`idempotencyTtlSeconds`, default 24h) returns the cached result and skips re-execution — safe retries for flaky networks and agent loops.

## Rate limiting

Each tool has a class — `read`, `write`, or `bulk` — enforced by a per-vault token bucket plus a max-concurrent-writes-per-vault cap. A trip returns `rate_limit` with `retry_after_ms`.

## Error taxonomy (selected)

| Error | Meaning | Retryable |
|---|---|---|
| `acl_denied` | Path outside allowed scope, or bad/expired token | no |
| `read_only_mode` | Kill switch active | no |
| `elicit_required` | HITL confirmation needed (see `details.elicit_token`) | yes, after elicit |
| `concurrent_modification` | File changed between read and write | yes, with re-read |
| `rate_limit` | Throttle hit | yes, after `retry_after_ms` |
| `plugin_missing` / `plugin_unreachable` | Bridge dependency absent / endpoint failed | no / yes |
| `bulk_partial` | Per-item failures (see `details.results[]`) | partial |

## Reporting security issues

Do **not** file security issues as public GitHub Issues. Follow [`SECURITY.md`](https://github.com/The-40-Thieves/obsidian-tc/blob/main/SECURITY.md).
