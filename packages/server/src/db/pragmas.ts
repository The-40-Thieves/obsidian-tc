/**
 * The per-connection baseline every adapter applies (THE-273), as pragma BODIES without the
 * `PRAGMA ` keyword: better-sqlite3's `pragma()` takes them bare, and the other two adapters
 * template the keyword back on.
 *
 * It lives here rather than inline in each adapter because it was previously copied into all
 * three, and a defect in the ORDER was therefore present in all three (THE-745 / #719).
 *
 * **The order is load-bearing, and `busy_timeout` MUST stay first.** SQLite's busy handler is
 * per-connection state installed BY the `busy_timeout` pragma; until it runs, a connection has no
 * handler at all and contention returns `SQLITE_BUSY` immediately instead of retrying. Converting
 * a database INTO WAL needs an EXCLUSIVE lock, so when several connections open a not-yet-WAL
 * database at once — a fresh install, a wiped cacheDir, the first boot after a cache reset — the
 * losers threw at ~0.3 ms rather than waiting out the timeout. Failing FAST is the signature of an
 * absent handler; failing at ~`busy_timeout` would mean the handler worked and contention genuinely
 * outlived it. Once a database is in WAL the conversion is a no-op and the window closes, which is
 * why a long-running deployment never reproduces this and a first boot does.
 */
export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/**
 * WAL + `synchronous = NORMAL` is the documented safe pairing; the larger page cache and mmap keep
 * the brute-force scan and the recursive graph walk resident.
 *
 * @param busyTimeoutMs overridable both by a test (asserting the ORDERING against a short timeout
 *   without blocking for the production value) and, in production, by config's `db.busyTimeoutMs`
 *   (THE-935) — every adapter's open function forwards its own parameter through to here rather
 *   than calling this bare, so the configured value reaches the connection instead of silently
 *   falling back to DEFAULT_BUSY_TIMEOUT_MS.
 */
export function connectionPragmas(busyTimeoutMs: number = DEFAULT_BUSY_TIMEOUT_MS): string[] {
  return [
    // MUST be first — see the note above. Everything below can contend.
    `busy_timeout = ${busyTimeoutMs}`,
    "foreign_keys = ON",
    "journal_mode = WAL",
    "synchronous = NORMAL",
    "cache_size = -32000",
    "temp_store = MEMORY",
    "mmap_size = 268435456",
  ];
}

/**
 * THE-1039 (F2, revised in fix round 2/C1) — the pragma set for `opts.readonly` connections.
 * `readonly` no longer means a native OS-level `SQLITE_OPEN_READONLY` open (that broke on macOS —
 * see bun-sqlite.ts's comment); the guarantee this function provides is now the WHOLE story: a
 * connection that issues no pragma capable of writing.
 *
 * `journal_mode = WAL` is the one pragma above that is NOT purely connection-local: on a database
 * still in the (default) DELETE journal mode, setting it requires an exclusive write lock and
 * rewrites the file header plus creates `-wal`/`-shm` sidecars — a byte-for-byte and journal-mode
 * change to a file an "inspect it" caller (`compact --dry-run`, `--into`'s SOURCE read, doctor's
 * `probeDbSpace`) has no business writing to. `synchronous`/`cache_size`/`temp_store`/`mmap_size`
 * are pure per-connection tuning with no on-disk effect either way, but are dropped too here for
 * the same reason `journal_mode` is: a caller asking for `readonly` gets a connection that issues
 * no PRAGMA capable of writing, not a connection that merely refrains from THIS release's known
 * offender. `busy_timeout` is kept — it is session state, never written to the file, and a reader
 * can still hit `SQLITE_BUSY` against a writer holding an exclusive checkpoint.
 */
export function readonlyConnectionPragmas(
  busyTimeoutMs: number = DEFAULT_BUSY_TIMEOUT_MS,
): string[] {
  return [`busy_timeout = ${busyTimeoutMs}`];
}
