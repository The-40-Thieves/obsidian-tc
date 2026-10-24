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
  /** (path, content hash) pairs the gate has already passed inside this frame. */
  readonly passed: Set<string>;
}

const frame = new AsyncLocalStorage<Frame>();

/** Run `fn` with `gate` installed: every `.md` write inside it is checked. Sync and async `fn` alike. */
export function withWriteGate<T>(gate: NoteWriteGate, fn: () => T): T {
  return frame.run({ gate, passed: new Set() }, fn);
}

function checkNoteWrite(abs: string, text: string | Buffer): void {
  const current = frame.getStore();
  if (current === undefined || !abs.toLowerCase().endsWith(".md")) return;
  const utf8 = typeof text === "string" ? text : text.toString("utf8");
  const key = `${abs}\0${contentHash(utf8)}`;
  if (current.passed.has(key)) return;
  current.gate.check(abs, utf8);
  current.passed.add(key);
}

/** Gate a note write: throws when the frame's gate blocks it. A no-op with no frame or for a path
 *  that does not end in `.md`. */
export function gateNoteWrite(abs: string, text: string | Buffer): void {
  checkNoteWrite(abs, text);
}

/** The same check, run early by a sequence with side effects before its final write. The verdict is
 *  memoised for the frame, so the sink's own gateNoteWrite does not check the same content again. */
export function preflightNoteWrite(abs: string, text: string | Buffer): void {
  checkNoteWrite(abs, text);
}

/** Tell the frame's gate that a note moved from `srcRel` to `destRel`. A no-op outside a frame. */
export function noteWriteOrigin(destRel: string, srcRel: string): void {
  frame.getStore()?.gate.origin?.(destRel, srcRel);
}
