import { existsSync, statSync } from "node:fs";

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
 * THE-1039 (C2) — test-only escape hatch, the shape of `search/native.ts`'s
 * `OBSIDIAN_TC_FORCE_JS_FALLBACK`: SKIPS the native readonly attempt so the fallback branch can be
 * asserted on any OS. It cannot exercise a native FAILURE — `forcedReadonlyOpenThrow` is for that.
 */
export function forceReadonlyOpenFallback(): boolean {
  return process.env.OBSIDIAN_TC_FORCE_READONLY_OPEN_FALLBACK === "1";
}

/**
 * THE-1039 (M1) — test-only fault hook for `compact --into`, here beside the other two so this
 * ticket's hooks stay enumerable in one place. `=1` makes the step right after `VACUUM INTO` throw a
 * plain Error, `=busy` a SQLITE_BUSY-shaped one; unset injects nothing. It replaces a fixture that
 * needed `VACUUM INTO` to leave a copy for a later step to choke on — build-dependent, and untrue on
 * macOS, where no copy was produced and the retained-copy assertion failed.
 */
export function forcedCompactIntoFailure():
  | { kind: "throw"; error: Error }
  | { kind: "delete"; table: string }
  | undefined {
  const mode = process.env.OBSIDIAN_TC_FORCE_COMPACT_INTO_FAILURE;
  if (mode === undefined) return undefined;
  // `delete:<table>` drops one row from the COPY before verification, the only deterministic way to
  // produce a REAL row-count mismatch: `VACUUM INTO` is faithful by design, so nothing a fixture can
  // do to the source will make the copy disagree.
  if (mode.startsWith("delete:")) return { kind: "delete", table: mode.slice("delete:".length) };
  if (mode !== "1" && mode !== "busy") return undefined;
  const error = new Error(`OBSIDIAN_TC_FORCE_COMPACT_INTO_FAILURE=${mode}`);
  if (mode === "busy") (error as Error & { code?: string }).code = "SQLITE_BUSY";
  return { kind: "throw", error };
}

/**
 * THE-1039 — test-only hook making the NATIVE readonly attempt FAIL inside the adapter, so the real
 * attempt -> refusal check -> writable-open path runs where the native open would otherwise succeed.
 * `=1` throws at the PROBE step, modelling the macOS shape (construction succeeds, the first
 * statement fails); `=construct` throws before the handle is used. Unset in production.
 */
export function forcedReadonlyOpenThrow(): "construct" | "probe" | undefined {
  const mode = process.env.OBSIDIAN_TC_FORCE_READONLY_OPEN_THROW;
  if (mode === "1") return "probe";
  return mode === "construct" ? "construct" : undefined;
}

/**
 * THE-1039 — the fallback condition is THE PATH, and nothing about the error: readonly failed, so
 * try writable, provided the target is an existing REGULAR FILE. Matching the error's shape instead
 * (a `code`/`errno`/text test) broke `build-test (macos-latest)` twice, since the macOS error is not
 * observable from this sandbox. The file guard is what the original unconditional fallback lacked:
 * node:sqlite's fallback is a plain open, so a missing file would be CREATED rather than reported.
 *
 * Two consequences are accepted deliberately: a permissions-denied file falls through to the
 * writable open, which fails with SQLite's own error (louder than a refusal invented here); and a
 * pending HOT-JOURNAL rollback (`SQLITE_READONLY_ROLLBACK`) also falls through, so the writable open
 * PERFORMS that recovery — inspecting a database whose writer died mid-transaction can complete its
 * rollback where the native readonly open is unavailable.
 *
 * @returns the reason the fallback is refused, or `undefined` when it may proceed.
 */
export function readonlyFallbackRefusal(path: string): string | undefined {
  try {
    if (!statSync(path).isFile()) return "the path is not a regular file";
  } catch (err) {
    const code = (err as { code?: unknown } | null | undefined)?.code;
    return `the path could not be stat'd (${String(code ?? (err as Error)?.message)})`;
  }
  return undefined;
}

/** The observable facts of an open failure, for a diagnostic a CI log can be read against. */
function errorFacts(e: unknown): string {
  const o = e as { code?: unknown; errno?: unknown } | null | undefined;
  return `code=${String(o?.code ?? "none")} errno=${String(o?.errno ?? "none")} msg=${
    e instanceof Error ? e.message : String(e)
  }`;
}

/** `-wal`/`-shm` existence before any open attempt: did the FAILED readonly attempt create a sidecar
 *  and poison the open after it? Recorded, never deleted — unlinking a `-shm` another process may
 *  hold mapped is its own corruption risk, and this path exists to INSPECT. */
function sidecarState(path: string): string {
  return `-wal=${existsSync(`${path}-wal`)} -shm=${existsSync(`${path}-shm`)}`;
}

/** The error to throw: the original message (plus `code`/`errno`/stack, which `busyReason` and
 *  open.ts's better-sqlite3-unavailable sniff both read) with the diagnosis appended. That detail
 *  must never name an adapter or say "cannot find module" — open.ts routes on those words. */
function annotated(e: unknown, detail: string): unknown {
  if (e instanceof Error) {
    e.message = `${e.message} [${detail}]`;
    return e;
  }
  return new Error(`${String(e)} [${detail}]`);
}

/**
 * The readonly-first-with-fallback open, ONCE, for all three adapters (each passes its own two
 * constructors plus a probe/close pair for its handle type).
 *
 * `configure` + `probe` run INSIDE the attempt, which is load-bearing, not tidiness: **bun:sqlite's
 * `{ readonly: true }` constructor is LAZY.** Measured directly — against a database in a directory
 * this process cannot write, the constructor SUCCEEDS and the failure surfaces on the FIRST
 * STATEMENT (SQLite defers the WAL `-shm` mapping until first access, and a readonly connection that
 * must create `-shm` and cannot reports "unable to open database file" there). A wrapper guarding
 * only construction hands back a "native" handle that fails later, outside it — which is why two
 * rounds of diagnostics never appeared in the macOS log at all. Applying the readonly pragma set and
 * one cheap header read before returning converts a deferred failure into an open failure the
 * fallback can handle; both branches are probed, so neither returns a handle unproven for reading.
 *
 * Both failure shapes stay distinguishable in the thrown message: "fallback refused because
 * <reason>" versus "fallback open also failed (<facts>)", the latter carrying the sidecar state
 * before the first attempt and after it.
 */
export function openReadonlyWithFallback<T>(
  path: string,
  nativeOpen: () => T,
  fallbackOpen: () => T,
  handle: { configure: (db: T) => void; probe: (db: T) => void; close: (db: T) => void },
): { db: T; readonlyMode: "native" | "fallback" } {
  const sidecarsBefore = sidecarState(path);
  const forcedThrow = forcedReadonlyOpenThrow();
  const cantopen = (): Error =>
    Object.assign(new Error("unable to open database file"), {
      code: "SQLITE_CANTOPEN",
      errno: 14,
    });
  const ready = (db: T, step: "construct" | "probe" | undefined): T => {
    try {
      if (step === "construct") throw cantopen();
      handle.configure(db);
      if (step === "probe") throw cantopen();
      handle.probe(db);
      return db;
    } catch (e) {
      try {
        handle.close(db);
      } catch {
        /* the handle is being discarded; a close failure adds nothing */
      }
      throw e;
    }
  };
  let nativeFailure: unknown;
  if (!forceReadonlyOpenFallback()) {
    try {
      return { db: ready(nativeOpen(), forcedThrow), readonlyMode: "native" };
    } catch (e) {
      const refusal = readonlyFallbackRefusal(path);
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
    return { db: ready(fallbackOpen(), undefined), readonlyMode: "fallback" };
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
