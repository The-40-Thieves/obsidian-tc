import { closeSync, existsSync, openSync, statSync } from "node:fs";

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
 * THE-1039 fix round 3 (C2) — test-only escape hatch, same shape as `search/native.ts`'s
 * `OBSIDIAN_TC_FORCE_JS_FALLBACK`: forces every adapter's readonly-first-with-fallback open (see
 * `OpenOptions` in types.ts) straight to its fallback branch, without needing to actually break the
 * native `SQLITE_OPEN_READONLY` open on this machine (that failure is macOS/WAL-specific and this
 * sandbox cannot reproduce it — see bun-sqlite.ts's C1 comment). A production process never sets
 * this; a test does, to exercise and assert on the fallback branch deterministically on any OS.
 */
export function forceReadonlyOpenFallback(): boolean {
  return process.env.OBSIDIAN_TC_FORCE_READONLY_OPEN_FALLBACK === "1";
}

/**
 * THE-1039 fix round 4 (M1) — test-only fault hook for `compact --into`, beside
 * `forceReadonlyOpenFallback` so this ticket's test-only hooks stay enumerable in one place.
 * `OBSIDIAN_TC_FORCE_COMPACT_INTO_FAILURE=1` makes the step right after `VACUUM INTO` throw a plain
 * Error; `=busy` makes it throw a SQLITE_BUSY-shaped one. Returns `undefined` (inject nothing) when
 * unset, which is every production process.
 *
 * It replaces a fixture that corrupted a source database with the `sqlite3` CLI and relied on
 * `VACUUM INTO` still producing a copy for a later step to choke on: that premise is
 * build-dependent, and on macOS's SQLite no copy was created at all, so `build-test (macos-latest)`
 * failed the retained-copy assertion while Linux passed. A hook at the exact position under test is
 * deterministic on every SQLite build.
 */
export function forcedCompactIntoFailure(): Error | undefined {
  const mode = process.env.OBSIDIAN_TC_FORCE_COMPACT_INTO_FAILURE;
  if (mode !== "1" && mode !== "busy") return undefined;
  const e = new Error(`OBSIDIAN_TC_FORCE_COMPACT_INTO_FAILURE=${mode}`);
  if (mode === "busy") (e as Error & { code?: string }).code = "SQLITE_BUSY";
  return e;
}

/**
 * THE-1039 fix round 4 (H1), widened and made diagnosable in fix round 5 — the ONE
 * native-readonly-open failure class an adapter may fall back from, or the reason it may not.
 *
 * Round 3's catch was unconditional, which silently routed three unrelated failures onto the
 * writable descriptor: a MISSING file (node:sqlite's fallback is a plain open, so it CREATES the
 * database), an UNREADABLE one, and SQLite refusing a readonly open because HOT-JOURNAL recovery is
 * pending — the worst of the three, since the writable open then PERFORMS that rollback
 * (`SQLITE_READONLY_ROLLBACK`, "attempt to write a readonly database"), a mutation class none of the
 * readonly guarantees here ever claimed to cover.
 *
 * C1's macOS failure — the only reason the fallback exists — is the `SQLITE_CANTOPEN` class, now
 * detected by THREE independent signals, since round 4's narrower code/text match refused the
 * fallback on macOS and broke `build-test (macos-latest)`: a `code` containing `SQLITE_CANTOPEN`, a
 * numeric `errno` of 14 (what some bindings report instead of a string), or the message "unable to
 * open database file". The message is matched RAW — this runs in the adapter's own catch, before any
 * caller prefixes it (`compact`/`probeDbSpace` add `<db>: ` only when printing or reporting).
 *
 * Round 5 also drops the write-access requirement and tests readability by OPENING the file rather
 * than via `accessSync`/`fs.constants`: the fallback descriptor does want write access, but a
 * readable-not-writable file should fail LOUDLY in the fallback open, not be refused here — and the
 * round-4 refusal could not be attributed to either check without naming which clause fired.
 *
 * @returns the reason the fallback is refused, or `undefined` when it may proceed.
 */
export function readonlyFallbackRefusal(path: string, e: unknown): string | undefined {
  let fd: number | undefined;
  try {
    if (!statSync(path).isFile()) return "the path is not a regular file";
    fd = openSync(path, "r"); // the same access the readonly open itself needs
  } catch (err) {
    const code = (err as { code?: unknown } | null | undefined)?.code;
    return `the file is not readable (${String(code ?? (err as Error)?.message)})`;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const facts = e as { code?: unknown; errno?: unknown } | null | undefined;
  if (typeof facts?.code === "string" && facts.code.includes("SQLITE_CANTOPEN")) return undefined;
  if (facts?.errno === SQLITE_CANTOPEN) return undefined;
  if (/unable to open database file/i.test(e instanceof Error ? e.message : String(e))) {
    return undefined;
  }
  return `the error is not the SQLITE_CANTOPEN class (${errorFacts(e)})`;
}

/** The boolean form, for call sites and tests that only need the verdict. */
export function readonlyOpenFallbackable(path: string, e: unknown): boolean {
  return readonlyFallbackRefusal(path, e) === undefined;
}

/** SQLite's primary result code for "unable to open database file". */
const SQLITE_CANTOPEN = 14;

/** The observable facts of an open failure, for a diagnostic a CI log can be read against. */
function errorFacts(e: unknown): string {
  const o = e as { code?: unknown; errno?: unknown } | null | undefined;
  return `code=${String(o?.code ?? "none")} errno=${String(o?.errno ?? "none")} msg=${
    e instanceof Error ? e.message : String(e)
  }`;
}

/** `-wal`/`-shm` existence, snapshotted before any open attempt, to answer the one question a
 *  failing fallback otherwise cannot: did the FAILED readonly attempt create a sidecar and poison
 *  the open after it? Recorded, never deleted — unlinking a `-shm` another process may hold mapped
 *  is its own corruption risk, and this path exists to INSPECT. */
function sidecarState(path: string): string {
  return `-wal=${existsSync(`${path}-wal`)} -shm=${existsSync(`${path}-shm`)}`;
}

/** Annotate and return the error to throw: the original message (plus `code`/`errno`/stack, so
 *  `busyReason` and open.ts's better-sqlite3-unavailable sniff still see what they expect) with the
 *  diagnosis appended. The detail deliberately never names an adapter or says "cannot find module"
 *  — open.ts routes on exactly those words. */
function annotated(e: unknown, detail: string): unknown {
  if (e instanceof Error) {
    e.message = `${e.message} [${detail}]`;
    return e;
  }
  return new Error(`${String(e)} [${detail}]`);
}

/**
 * THE-1039 fix round 5 — the readonly-first-with-fallback open, ONCE, for all three adapters (each
 * passes its own two constructors); round 4 hand-rolled it three times. The two failure shapes are
 * distinguishable in the thrown message: "fallback refused because <reason>" versus "fallback open
 * also failed (<facts>)", the latter carrying the sidecar state before the first attempt and after.
 */
export function openReadonlyWithFallback<T>(
  path: string,
  nativeOpen: () => T,
  fallbackOpen: () => T,
): { db: T; readonlyMode: "native" | "fallback" } {
  const sidecarsBefore = sidecarState(path);
  let nativeFailure: unknown;
  if (!forceReadonlyOpenFallback()) {
    try {
      return { db: nativeOpen(), readonlyMode: "native" };
    } catch (e) {
      const refusal = readonlyFallbackRefusal(path, e);
      if (refusal !== undefined) {
        throw annotated(
          e,
          `readonly open failed (${errorFacts(e)}); fallback refused because ${refusal}`,
        );
      }
      nativeFailure = e;
    }
  }
  try {
    return { db: fallbackOpen(), readonlyMode: "fallback" };
  } catch (e) {
    const first =
      nativeFailure === undefined ? "not attempted (forced)" : errorFacts(nativeFailure);
    throw annotated(
      e,
      `readonly open failed (${first}); fallback open also failed (${errorFacts(e)}); ` +
        `sidecars before the first attempt: ${sidecarsBefore}; now: ${sidecarState(path)}`,
    );
  }
}

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
 * THE-1039 (F2, revised in fix round 2/C1, narrowed again in fix round 3/C2) — the pragma set for
 * `opts.readonly` connections, applied regardless of which open strategy the adapter actually used
 * (see `OpenOptions`'s comment in types.ts — native readonly first, with a writable-fd fallback
 * only if that throws).
 *
 * `journal_mode = WAL` is the one pragma above that is NOT purely connection-local: on a database
 * still in the (default) DELETE journal mode, setting it requires an exclusive write lock and
 * rewrites the file header plus creates `-wal`/`-shm` sidecars — a byte-for-byte and journal-mode
 * change to a file an "inspect it" caller (`compact --dry-run`, `--into`'s SOURCE read, doctor's
 * `probeDbSpace`) has no business writing to. `synchronous`/`cache_size`/`temp_store`/`mmap_size`
 * are pure per-connection tuning with no on-disk effect either way, but are dropped too here for
 * the same reason `journal_mode` is: a caller asking for `readonly` gets a connection that issues
 * no PRAGMA capable of writing. `busy_timeout` is kept — it is session state, never written to the
 * file, and a reader can still hit `SQLITE_BUSY` against a writer holding an exclusive checkpoint.
 *
 * C2: "issues no write-capable pragma" is NOT the whole story on bytes-unchanged, and this
 * function's own guarantee stops at pragmas — it says nothing about what the OPEN itself can do.
 * When the native `SQLITE_OPEN_READONLY` open succeeds (`Database.readonlyMode === "native"`),
 * there is no logical or configuration change AND bytes are unchanged. When it does not and the
 * adapter falls back to a writable file descriptor (`readonlyMode === "fallback"`), this function's
 * guarantee still holds — no write-capable pragma is issued — but bytes may STILL change, because
 * SQLite itself can run a checkpoint against a dangling WAL when that writable connection closes.
 * See each adapter's own comment on its fallback branch.
 */
export function readonlyConnectionPragmas(
  busyTimeoutMs: number = DEFAULT_BUSY_TIMEOUT_MS,
): string[] {
  return [`busy_timeout = ${busyTimeoutMs}`];
}
