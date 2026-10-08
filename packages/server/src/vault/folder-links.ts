// The native safe-open follows NO symlink in any path component, so a configured vault folder that is
// a symlink (`wiki -> pages`, `raw -> sources`) cannot be opened by its configured name. This module
// is the one place that bridges the two, through PINS.
//
// A pin is placed when a vault registry is built (vault/registry.ts): each configured `wiki.folder` /
// `wiki.rawFolder` that is reached through a symlink is resolved to its real directory, which must
// sit strictly inside the vault root (otherwise no pin: the native open keeps refusing, fail closed),
// and the directory's identity (dev, ino) is recorded with it. The pins belong to that registry
// (`FolderPins`) and never change after it is built, so another registry in the same process (a
// session_rerun sandbox builds one) cannot touch them. A request reaches its registry's pins through
// the dispatch frame (`withFolderPins`, set by mcp/registry.ts around every tool and resource call);
// outside a frame there are none, which is the fail-closed native behaviour. Within a frame:
//  - the ACL (resolveVaultPathChecked) refuses a path under a pinned folder whose live realpath no
//    longer equals the pinned one, so a retargeted symlink is never authorized;
//  - the native sinks (notes-io) open the pinned directory by `pinnedOpenPath`, a pure function of
//    the pins and the path, and the native walk checks the opened directory's identity against the
//    pin, so a directory renamed into the pinned name after the ACL decision is refused.
import { AsyncLocalStorage } from "node:async_hooks";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

/** A pinned folder's real directory and its identity when pinned: what the native open verifies. */
export interface PinnedDir {
  dir: string;
  dev: bigint;
  ino: bigint;
}

/** One configured folder of one vault. `pinned`: placed at build. `deferred`: a wiki folder whose
 *  root was missing at build, placed once by the first ACL resolution through it (then `pinned`,
 *  `refused` or gone). `unplaced-raw`: a raw folder whose root was missing at build: its canonical
 *  target never got the immutable rules (runtime/acl-build.ts), so while it is a symlink every path
 *  under it is refused until the next restart. `refused`: a deferred wiki folder that turned out to
 *  lead into the raw folder. `none`: a deferred folder that was not a symlink after all. */
type Slot = {
  readonly root: string;
  readonly alias: string;
  /** On a wiki slot: the same vault's raw folder, which a deferred wiki pin must not overlap. */
  readonly rawAlias?: string;
  state:
    | { kind: "pinned"; pin: PinnedDir }
    | { kind: "deferred" }
    | { kind: "unplaced-raw" }
    | { kind: "refused"; reason: string }
    | { kind: "none" };
};

/** What the ACL must do with a path: nothing, check it against a pin, or refuse it. */
export type FolderPinVerdict =
  | { kind: "none" }
  | { kind: "pinned"; path: string }
  | { kind: "refused"; reason: string };

const under = (abs: string, alias: string): boolean => abs === alias || abs.startsWith(alias + sep);

/** The pin of `alias` when it is a symlinked directory strictly inside `root`, else null. */
function pinOf(root: string, alias: string): PinnedDir | null {
  try {
    const dir = realpathSync(alias);
    const rel = relative(root, dir);
    const inside = rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
    if (dir === alias || !inside) return null;
    const st = statSync(dir, { bigint: true });
    return st.isDirectory() ? { dir, dev: st.dev, ino: st.ino } : null;
  } catch {
    return null;
  }
}

const realpathOrNull = (p: string): string | null => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};

/** One vault's configured folders, vault-relative and `/`-separated, as the registry resolved them. */
export interface PinnedVault {
  root: string;
  wikiFolder?: string | undefined;
  rawFolder?: string | undefined;
}

/** The folder pins of ONE vault registry, fixed when it is built. */
export class FolderPins {
  /** Most specific root first, then the longest alias: the first match is the one that applies. */
  private readonly slots: readonly Slot[];

  constructor(vaults: ReadonlyArray<PinnedVault>) {
    this.slots = vaults
      .flatMap(slotsOf)
      .sort((a, b) => b.root.length - a.root.length || b.alias.length - a.alias.length);
  }

  private slotFor(abs: string): Slot | undefined {
    // A deferred folder placed as `none` is skipped, so it never shadows an outer root's pin.
    return this.slots.find((s) => s.state.kind !== "none" && under(abs, s.alias));
  }

  /** The ACL's view of `abs`. Places the deferred wiki pin `abs` runs through, once, from the folder
   *  as it is now. */
  forAcl(abs: string): FolderPinVerdict {
    const slot = this.slotFor(abs);
    if (slot === undefined) return { kind: "none" };
    if (slot.state.kind === "deferred") placeDeferred(slot);
    const { state } = slot;
    if (state.kind === "refused") return state;
    if (state.kind === "pinned") return { kind: "pinned", path: swap(abs, slot.alias, state.pin) };
    if (state.kind === "unplaced-raw" && realpathOrNull(slot.root) === slot.root) {
      const real = realpathOrNull(slot.alias);
      if (real !== null && real !== slot.alias)
        return {
          kind: "refused",
          reason: `the configured raw folder is a symlink that appeared after startup (the vault root was missing then), so its target is not protected as immutable yet: restart the server to pin it`,
        };
    }
    return { kind: "none" };
  }

  /** The sink's view of `abs`: the pin it runs through, if one is placed. Reads no filesystem. */
  forSink(abs: string): { alias: string; pin: PinnedDir } | undefined {
    const slot = this.slotFor(abs);
    return slot?.state.kind === "pinned" ? { alias: slot.alias, pin: slot.state.pin } : undefined;
  }
}

const swap = (abs: string, alias: string, pin: PinnedDir): string =>
  pin.dir + abs.slice(alias.length);

/** Resolve one vault's configured folders to slots, now. A folder that is not a symlink, is missing,
 *  is not a directory, or does not lead strictly inside the vault gets none, as does every folder
 *  of a root that exists but is not its own real path. A missing root defers the wiki folder and
 *  marks the raw folder unplaced (see `Slot`). */
function slotsOf(v: PinnedVault): Slot[] {
  const alias = (folder: string) => join(v.root, ...folder.split("/"));
  const rawAlias = v.rawFolder === undefined ? undefined : alias(v.rawFolder);
  const wikiAlias = v.wikiFolder === undefined ? undefined : alias(v.wikiFolder);
  const realRoot = realpathOrNull(v.root);
  if (realRoot === null)
    return [
      ...(wikiAlias === undefined
        ? []
        : [{ root: v.root, alias: wikiAlias, rawAlias, state: { kind: "deferred" as const } }]),
      ...(rawAlias === undefined
        ? []
        : [{ root: v.root, alias: rawAlias, state: { kind: "unplaced-raw" as const } }]),
    ];
  if (realRoot !== v.root) return [];
  return [wikiAlias, rawAlias].flatMap((a) => {
    const pin = a === undefined ? null : pinOf(v.root, a);
    return a === undefined || pin === null
      ? []
      : [{ root: v.root, alias: a, state: { kind: "pinned" as const, pin } }];
  });
}

/** Place a deferred wiki slot from the folder as it is now: pinned, refused when it leads into (or
 *  around) the raw folder, which the ACL never made immutable under that name, or gone. A root still
 *  missing stays deferred. */
function placeDeferred(slot: Slot): void {
  const realRoot = realpathOrNull(slot.root);
  if (realRoot === null) return;
  const pin = realRoot === slot.root ? pinOf(slot.root, slot.alias) : null;
  const raw = slot.rawAlias === undefined ? null : realpathOrNull(slot.rawAlias);
  if (pin !== null && raw !== null && (under(pin.dir, raw) || under(raw, pin.dir)))
    slot.state = {
      kind: "refused",
      reason: `the configured wiki folder leads into the raw folder (it was placed after startup, when the vault root appeared), so it is refused: point the wiki folder elsewhere and restart the server`,
    };
  else slot.state = pin === null ? { kind: "none" } : { kind: "pinned", pin };
}

const NO_PINS = new FolderPins([]);
const frame = new AsyncLocalStorage<FolderPins>();

/** Run `fn` (a dispatch) against `pins`: the ACL and the sinks inside it see that registry's pins. */
export function withFolderPins<T>(pins: FolderPins | undefined, fn: () => T): T {
  return frame.run(pins ?? NO_PINS, fn);
}

/** The ACL's view of `abs` under the current dispatch's pins (none outside a dispatch). */
export function folderPinVerdict(abs: string): FolderPinVerdict {
  return (frame.getStore() ?? NO_PINS).forAcl(abs);
}

/** `abs` as a sink opens it under the current dispatch's pins: a pinned folder's configured name
 *  swapped for its pinned directory, with the pin to verify; `abs` itself under no placed pin. */
export function pinnedOpenPath(abs: string): { path: string; pinned?: PinnedDir } {
  const hit = (frame.getStore() ?? NO_PINS).forSink(abs);
  return hit === undefined
    ? { path: abs }
    : { path: swap(abs, hit.alias, hit.pin), pinned: hit.pin };
}
