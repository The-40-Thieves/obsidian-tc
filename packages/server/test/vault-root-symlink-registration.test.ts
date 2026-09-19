// THE-1081 / #946 — vault root canonicalization at registration.
//
// `packages/native/src/lib.rs`'s `open_parent` walks every path component with O_NOFOLLOW from
// `/`, so a vault root reached through a symlinked ANCESTOR (macOS `$TMPDIR` resolves under
// `/var` -> `/private/var`) made the native addon refuse every read/write in that vault — 641 of
// 4,882 server tests failed this way on a stock Mac with the addon built, because 104 fixture
// files build their vault root under `mkdtempSync(join(tmpdir(), ...))`. The JS fallback accepted
// the identical root (its own realpath-containment check in `vault/paths.ts` only cares about
// escaping the root, not about the root's own ancestors), so the two backends disagreed on a real
// vault configured the same way. `VaultRegistry` now canonicalizes a configured root through
// realpath once, at registration (`vault/registry.ts`), so both backends open the vault by the
// same real path.
//
// Own file, not added to vault-primitives.test.ts: the JS-fallback arm below needs
// `vi.resetModules()` + a dynamic re-import of `notes-io.ts`, because that module's native/JS
// selection is decided once at module load from `OBSIDIAN_TC_FORCE_JS_FALLBACK` (see its own file
// header) — a different isolation shape than every synchronous test already in that file.
//
// Four things this file proves:
//   1. VaultRegistry stores the REAL root, not the lexical (symlinked-ancestor) one — both from
//      the constructor (config-file vaults) and from register() (the add_vault runtime path).
//   2. A read/write through a vault registered via a symlinked ancestor succeeds against the REAL
//      compiled native binding (skipped, not silently passed, when this host has none — the same
//      `nativeLoaded` gate native-contract.test.ts uses).
//   3. The same read/write succeeds through the JS fallback (OBSIDIAN_TC_FORCE_JS_FALLBACK=1).
//   4. A symlink INSIDE the vault escaping the root is still refused by both backends — this
//      ticket does not relax `open_parent`'s per-component rule or paths.ts's containment check.
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveVaultPath, walkVault, walkVaultStream } from "../src/vault/paths";
import { canonicalizeVaultRoot, VaultRegistry } from "../src/vault/registry";
import { rmTemp } from "./tmp";

const requireCjs = createRequire(import.meta.url);

// The package's OWN `nativeLoaded` flag — the only signal that distinguishes "real napi binding"
// from "the package's internal JS fallback" (see native-contract.test.ts for why this, and not
// `search/native.ts`'s loader, is the correct gate).
const nativeModule = requireCjs("../../native/index.js") as {
  nativeLoaded?: boolean;
  safeReadNote?: (abs: string) => Buffer;
  safeWriteNoteAtomic?: (abs: string, data: Buffer) => void;
};
const isRealNative = nativeModule.nativeLoaded === true;

describe("THE-1081 / #946 — vault root canonicalization at registration", () => {
  let base: string;
  let realRootDir: string;
  let linkedRootDir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "obtc-root-symlink-"));
    realRootDir = join(base, "real-root");
    linkedRootDir = join(base, "link-root");
    mkdirSync(realRootDir);
    symlinkSync(realRootDir, linkedRootDir);
  });

  afterEach(() => {
    rmTemp(base);
  });

  it("constructor: stores the realpath, not the symlinked-ancestor lexical path", () => {
    const registry = new VaultRegistry([{ id: "v", path: linkedRootDir }]);
    // Compared against the SAME canonicalization production uses (canonicalizeVaultRoot,
    // realpathSync.native), never plain realpathSync: on GitHub's windows-latest runner the two
    // flavours return DIFFERENT spellings of the same directory (8.3 short vs. long form) for
    // os.tmpdir()-rooted paths, which made this fail on Windows only while the code was correct.
    expect(registry.resolve("v").root).toBe(canonicalizeVaultRoot(realRootDir));
    // Still pinned against the lexical (unresolved) symlinked path, so a regression that stopped
    // canonicalizing entirely would still be caught.
    expect(registry.resolve("v").root).not.toBe(linkedRootDir);
  });

  it("register(): the add_vault runtime path also canonicalizes", () => {
    const registry = new VaultRegistry([{ id: "seed", path: realRootDir }]);
    const v = registry.register({ id: "added", path: linkedRootDir });
    expect(v.root).toBe(canonicalizeVaultRoot(realRootDir));
    expect(v.root).not.toBe(linkedRootDir);
  });

  it.skipIf(!isRealNative)(
    "native binding: read/write through a symlinked-ancestor root succeeds",
    () => {
      const registry = new VaultRegistry([{ id: "v", path: linkedRootDir }]);
      const abs = resolveVaultPath(registry.resolve("v").root, "note.md");
      nativeModule.safeWriteNoteAtomic?.(abs, Buffer.from("hello", "utf8"));
      expect(nativeModule.safeReadNote?.(abs)?.toString("utf8")).toBe("hello");
    },
  );

  it.skipIf(!isRealNative)("native binding: a symlink escaping the vault is still refused", () => {
    const registry = new VaultRegistry([{ id: "v", path: linkedRootDir }]);
    const root = registry.resolve("v").root;
    const outsideTarget = join(base, "outside");
    mkdirSync(outsideTarget);
    const escapeLink = join(root, "escape");
    symlinkSync(outsideTarget, escapeLink);
    expect(() =>
      nativeModule.safeWriteNoteAtomic?.(join(escapeLink, "note.md"), Buffer.from("x")),
    ).toThrow(/refusing symlinked or missing path component/);
  });

  it("JS fallback: read/write through a symlinked-ancestor root succeeds", async () => {
    vi.resetModules();
    const prevFallback = process.env.OBSIDIAN_TC_FORCE_JS_FALLBACK;
    process.env.OBSIDIAN_TC_FORCE_JS_FALLBACK = "1";
    try {
      const notesIo = await import("../src/vault/notes-io");
      expect(notesIo.nativeVaultIo).toBe(false);
      const registry = new VaultRegistry([{ id: "v", path: linkedRootDir }]);
      const abs = resolveVaultPath(registry.resolve("v").root, "note.md");
      notesIo.writeNoteAtomic(abs, "hello");
      expect(notesIo.readNote(abs).raw).toBe("hello");
    } finally {
      if (prevFallback === undefined) delete process.env.OBSIDIAN_TC_FORCE_JS_FALLBACK;
      else process.env.OBSIDIAN_TC_FORCE_JS_FALLBACK = prevFallback;
      vi.resetModules();
    }
  });

  it("JS fallback: a symlink escaping the vault is still refused (realpath containment)", () => {
    const registry = new VaultRegistry([{ id: "v", path: linkedRootDir }]);
    const root = registry.resolve("v").root;
    const outsideTarget = join(base, "outside2");
    mkdirSync(outsideTarget);
    const escapeLink = join(root, "escape2");
    symlinkSync(outsideTarget, escapeLink);
    expect(() => resolveVaultPath(root, "escape2/note.md")).toThrow(/escapes the vault root/);
  });
});

// THE-1081 review round (Medium 2) — a root VaultRegistry could not canonicalize at registration
// (missing at boot) is stored by its LEXICAL config path, and `rootCanonical: false` records that.
// A local user who later plants a SYMLINK at that exact path must not have it silently
// dereferenced by the JS fallback's own realpath containment check — that would let
// `resolveVaultPathChecked` walk straight through an attacker-controlled symlink the native addon
// would refuse. A directory that later appears as a plain real dir is fine on both backends: only
// a symlink at the root itself is the attack.
describe("THE-1081 / #946 review round — missing-at-boot root, resolved later", () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "obtc-late-root-"));
  });
  afterEach(() => {
    rmTemp(base);
  });

  it("registers with rootCanonical:false and the lexical path when the directory does not exist yet", () => {
    const missing = join(base, "not-yet-created");
    const registry = new VaultRegistry([{ id: "v", path: missing }]);
    const v = registry.resolve("v");
    expect(v.rootCanonical).toBe(false);
    expect(v.root).toBe(missing);
  });

  it("JS fallback: works once the missing root is created as a REAL directory", () => {
    const missing = join(base, "not-yet-created-real");
    const registry = new VaultRegistry([{ id: "v", path: missing }]);
    const root = registry.resolve("v").root;
    mkdirSync(root);
    const abs = resolveVaultPath(root, "note.md");
    writeFileSync(abs, "hello", "utf8");
    expect(readFileSync(abs, "utf8")).toBe("hello");
  });

  it("JS fallback: REFUSED once the missing root is created as a SYMLINK (the plant)", () => {
    const missing = join(base, "not-yet-created-link");
    const registry = new VaultRegistry([{ id: "v", path: missing }]);
    const root = registry.resolve("v").root;
    const elsewhere = join(base, "attacker-controlled");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, root); // the plant: a symlink now sits exactly at the registered root
    expect(() => resolveVaultPath(root, "note.md")).toThrow(/vault root resolved to a symlink/);
  });

  it.skipIf(!isRealNative)(
    "native binding: works once the missing root is created as a REAL directory",
    () => {
      const missing = join(base, "not-yet-created-real-native");
      const registry = new VaultRegistry([{ id: "v", path: missing }]);
      const root = registry.resolve("v").root;
      mkdirSync(root);
      const abs = resolveVaultPath(root, "note.md");
      nativeModule.safeWriteNoteAtomic?.(abs, Buffer.from("hello", "utf8"));
      expect(nativeModule.safeReadNote?.(abs)?.toString("utf8")).toBe("hello");
    },
  );

  it.skipIf(!isRealNative)(
    "native binding: already refused once the missing root is created as a SYMLINK (native behaviour unchanged)",
    () => {
      const missing = join(base, "not-yet-created-link-native");
      const registry = new VaultRegistry([{ id: "v", path: missing }]);
      const root = registry.resolve("v").root;
      const elsewhere = join(base, "attacker-controlled-native");
      mkdirSync(elsewhere);
      symlinkSync(elsewhere, root);
      // Native never needed this fix: open_parent refuses ANY symlink component regardless of
      // when it appeared. resolveVaultPath itself now also refuses first (paths.ts, JS side), so
      // this exercises the native primitive directly to confirm it was never the gap.
      expect(() =>
        nativeModule.safeWriteNoteAtomic?.(join(root, "note.md"), Buffer.from("x")),
      ).toThrow(/refusing symlinked or missing path component/);
    },
  );

  // THE-1081 review round 2 (Residual) — walkVault/walkVaultStream with no `sub` read `root`
  // directly via readdirSync, bypassing resolveVaultPathChecked entirely. Before
  // assertRootNotPlantedSymlink was added to their own entry points, a planted-symlink root (this
  // same missing-at-boot -> symlink scenario) let list_notes enumerate the target directory's
  // names/sizes/mtimes even though content reads on those names were already refused.
  it("list-shaped (walkVault, no sub): REFUSED once the missing root is created as a SYMLINK", () => {
    const missing = join(base, "not-yet-created-list-link");
    const registry = new VaultRegistry([{ id: "v", path: missing }]);
    const root = registry.resolve("v").root;
    const elsewhere = join(base, "attacker-controlled-list");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "leaked-name.md"), "secret", "utf8");
    symlinkSync(elsewhere, root);
    expect(() => walkVault(root)).toThrow(/vault root resolved to a symlink/);
  });

  it("list-shaped (walkVaultStream, no sub): REFUSED once the missing root is created as a SYMLINK", async () => {
    const missing = join(base, "not-yet-created-liststream-link");
    const registry = new VaultRegistry([{ id: "v", path: missing }]);
    const root = registry.resolve("v").root;
    const elsewhere = join(base, "attacker-controlled-liststream");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, root);
    async function drain(): Promise<void> {
      for await (const _e of walkVaultStream(root)) {
        // draining is enough to trigger the entry-point guard
      }
    }
    await expect(drain()).rejects.toThrow(/vault root resolved to a symlink/);
  });

  it("list-shaped (walkVault, no sub): lists fine when the root itself is a symlink AT CONFIG TIME (canonical)", () => {
    const realRoot = join(base, "list-real-root");
    const linkRoot = join(base, "list-link-root");
    mkdirSync(realRoot);
    writeFileSync(join(realRoot, "note.md"), "hello", "utf8");
    symlinkSync(realRoot, linkRoot);
    // Registered through the symlink, same as any config path reached through a symlinked ancestor
    // or a symlinked root — VaultRegistry canonicalizes immediately, so `root` below is already
    // the dereferenced real path, never itself a symlink.
    const registry = new VaultRegistry([{ id: "v", path: linkRoot }]);
    const root = registry.resolve("v").root;
    expect(walkVault(root).map((e) => e.relPath)).toEqual(["note.md"]);
  });
});
