// The note write gate: a frame that lets a caller veto a note write at the vault's write chokepoints
// (notes-io's writeFileAtomic and stageNoteWrite) before any byte reaches disk. Outside a frame
// nothing is gated. The gate decides and throws to block; this module only routes. It imports
// nothing from conventions/ or mcp/: whoever installs a frame supplies the gate.
import { AsyncLocalStorage } from "node:async_hooks";
import { contentHash } from "./paths";

/** A caller's verdict on note writes: `check` throws to block the write. `origin` is told where a
 *  note was moved from, for the gate's own bookkeeping. */
export type NoteWriteGate = {
  check(abs: string, text: string): void;
  origin?(destRel: string, srcRel: string): void;
};

interface Frame {
  readonly gate: NoteWriteGate;
  /** (path, content hash) pairs a preflight has passed and no gate call has consumed yet. */
  readonly passed: Set<string>;
  /** Set once the frame's `fn` has settled: later work (a timer, a promise chain that outlives the
   *  call) is background work with no frame, so it is ungated. */
  closed: boolean;
}

const frame = new AsyncLocalStorage<Frame>();

/** Run `fn` with `gate` installed: every `.md` write inside it is checked. Sync and async `fn` alike.
 *  The frame closes when `fn` settles (a sync return or throw, an async resolve or reject). A nested
 *  withWriteGate replaces the outer gate for its own extent: the outer gate is not consulted there. */
export function withWriteGate<T>(gate: NoteWriteGate, fn: () => T): T {
  const scope: Frame = { gate, passed: new Set(), closed: false };
  const close = (): void => {
    scope.closed = true;
  };
  let result: T;
  try {
    result = frame.run(scope, fn);
  } catch (e) {
    close();
    throw e;
  }
  if (result instanceof Promise) result.then(close, close);
  else close();
  return result;
}

/** The live frame that gates a write to `abs`, or undefined: no frame, a closed frame, or a path
 *  that is not a note. */
function gatingFrame(abs: string): Frame | undefined {
  const current = frame.getStore();
  return current !== undefined && !current.closed && isNotePath(abs) ? current : undefined;
}

/** A note by its file name. Windows resolves `note.md.`, `note.md ` and `note.md::$DATA` to
 *  `note.md`, so trailing dots and spaces and any `:stream` suffix are allowed after `.md`. A name
 *  that merely contains a colon is gated too: the check is conservative on purpose. */
/** True when the last segment of `path` names a note (`.md`, case-insensitive, NTFS aliases included). */
export function isNotePath(path: string): boolean {
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  // A plain scan, not a regex: each end (the name's end, or a `:` that starts a stream suffix) is
  // tried with its trailing dots and spaces stepped over. File names are short, so this stays cheap.
  for (let end = 0; end <= name.length; end++) {
    if (end < name.length && name[end] !== ":") continue;
    let j = end - 1;
    while (j >= 0 && (name[j] === "." || name[j] === " ")) j--;
    if (j >= 2 && name.slice(j - 2, j + 1).toLowerCase() === ".md") return true;
  }
  return false;
}

function contentKey(abs: string, text: string | Buffer): { key: string; utf8: string } {
  const utf8 = typeof text === "string" ? text : text.toString("utf8");
  return { key: `${abs}\0${contentHash(utf8)}`, utf8 };
}

/** Gate a note write: throws when the frame's gate blocks it. A no-op with no frame or for a path
 *  that does not name a note. A verdict that a preflight recorded for this exact content is consumed
 *  here, one-shot: that call skips the check, and every later write is checked again. */
export function gateNoteWrite(abs: string, text: string | Buffer): void {
  const current = gatingFrame(abs);
  if (current === undefined) return;
  const { key, utf8 } = contentKey(abs, text);
  if (current.passed.delete(key)) return;
  current.gate.check(abs, utf8);
}

/** The same check, run early by a sequence with side effects before its final write. It always
 *  checks, and records the pass so the sink's own gateNoteWrite for the same content skips one check. */
export function preflightNoteWrite(abs: string, text: string | Buffer): void {
  const current = gatingFrame(abs);
  if (current === undefined) return;
  const { key, utf8 } = contentKey(abs, text);
  current.gate.check(abs, utf8);
  current.passed.add(key);
}

/** Tell the frame's gate that a note moved from `srcRel` to `destRel`. A no-op outside a live frame. */
export function noteWriteOrigin(destRel: string, srcRel: string): void {
  const current = frame.getStore();
  if (current !== undefined && !current.closed) current.gate.origin?.(destRel, srcRel);
}
