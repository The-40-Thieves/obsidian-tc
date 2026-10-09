// `session_rerun` / `rerun --sandbox` stage a disposable copy of the vault and replay recorded calls
// against it. The live read refuses a hard link (readNote's fstat on the OPEN fd, nlink > 1) and the
// folder ACL judges a symlink by where it leads; a staging copy that dereferences symlinks and
// re-creates every file as a fresh single-link inode launders both: the sandboxed readNote then
// accepts what the live read refused, and a replayed query-less vault_context feeds up to 600 chars of
// it to the embedding provider. Staging must carry the identity over (a file with more than one link,
// a symlink, is not copied), for the vault AND for the session-trace copy. Runs in the native-loaded
// CI step too: the native safe-open and the JS fallback refuse these by different code.

import {
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readNote } from "../src/vault/notes-io";
import { stageSandbox } from "../src/workspace/rerun";
import { CACHE_TRACE_SUBDIR } from "../src/workspace/sessions";
import { makeTempDir, rmTemp } from "./tmp";

const CANARY = "kvantorixsecretcanary";
const roots: string[] = [];
const disposers: Array<() => void> = [];
afterAll(() => {
  for (const d of disposers) d();
  for (const r of roots) rmTemp(r);
});

function fixture(): { root: string; outside: string; cacheDir: string } {
  const root = makeTempDir("obtc-stage-id-");
  const outside = makeTempDir("obtc-stage-out-");
  const cacheDir = makeTempDir("obtc-stage-cache-");
  roots.push(root, outside, cacheDir);
  for (const d of ["memory", "private", ".obsidian"]) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, "private", "secret.md"), `${CANARY} private thread`);
  writeFileSync(join(outside, "secret.md"), `${CANARY} outside thread`);
  return { root, outside, cacheDir };
}

async function stage(root: string, cacheDir: string) {
  const staged = await stageSandbox("main", root, cacheDir, 1000);
  disposers.push(staged.dispose);
  return staged;
}

/** Every regular file under `dir`, followed through symlinks, whose text holds the canary. */
function filesHoldingCanary(dir: string): string[] {
  const hits: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (statSync(p).isFile() && readFileSync(p, "utf8").includes(CANARY)) hits.push(p);
    }
  };
  walk(dir);
  return hits;
}

const NEXT = join("memory", "_next-session.md");

describe("stageSandbox does not launder a file's identity", () => {
  it("the live read refuses a hard-linked _next-session.md, and so does the staged copy", async () => {
    const { root, cacheDir } = fixture();
    linkSync(join(root, "private", "secret.md"), join(root, NEXT));
    expect(() => readNote(join(root, NEXT))).toThrow();
    const staged = await stage(root, cacheDir);
    expect(() => readNote(join(staged.root, NEXT))).toThrow();
    // The unrelated private note is still an ordinary single-link copy.
    expect(filesHoldingCanary(staged.root)).not.toContain(join(staged.root, NEXT));
  });

  it("the live read refuses a symlinked _next-session.md, and the staged copy never holds its target", async () => {
    const { root, outside, cacheDir } = fixture();
    symlinkSync(join(outside, "secret.md"), join(root, NEXT));
    const staged = await stage(root, cacheDir);
    expect(() => readNote(join(staged.root, NEXT))).toThrow();
    expect(filesHoldingCanary(staged.root)).toEqual([join(staged.root, "private", "secret.md")]);
  });

  it("a symlink to a note inside the vault is not turned into a copy either", async () => {
    const { root, cacheDir } = fixture();
    symlinkSync(join(root, "private", "secret.md"), join(root, NEXT));
    const staged = await stage(root, cacheDir);
    expect(() => readNote(join(staged.root, NEXT))).toThrow();
  });

  it("a symlinked folder to somewhere outside the vault is not followed into the copy", async () => {
    const { root, outside, cacheDir } = fixture();
    symlinkSync(outside, join(root, "memory", "linked"), "dir");
    const staged = await stage(root, cacheDir);
    expect(filesHoldingCanary(staged.root)).toEqual([join(staged.root, "private", "secret.md")]);
  });

  it("the session-trace copy does not launder a hard link or a symlink either", async () => {
    const { root, outside, cacheDir } = fixture();
    const traces = join(cacheDir, CACHE_TRACE_SUBDIR);
    mkdirSync(traces, { recursive: true });
    linkSync(join(root, "private", "secret.md"), join(traces, "hl.jsonl"));
    symlinkSync(join(outside, "secret.md"), join(traces, "sl.jsonl"));
    writeFileSync(join(traces, "ok.jsonl"), '{"ok":true}\n');
    const staged = await stage(root, cacheDir);
    const stagedTraces = join(staged.cacheDir, CACHE_TRACE_SUBDIR);
    expect(readdirSync(stagedTraces)).toEqual(["ok.jsonl"]);
  });

  it("positive control: an ordinary note, nested folders and .obsidian config still replay", async () => {
    const { root, cacheDir } = fixture();
    mkdirSync(join(root, "a", "b"), { recursive: true });
    writeFileSync(join(root, NEXT), "# next\nthread");
    writeFileSync(join(root, "a", "b", "n.md"), "nested");
    writeFileSync(join(root, ".obsidian", "app.json"), '{"x":1}');
    const staged = await stage(root, cacheDir);
    expect(readNote(join(staged.root, NEXT)).raw).toBe("# next\nthread");
    expect(readNote(join(staged.root, "a", "b", "n.md")).raw).toBe("nested");
    expect(readNote(join(staged.root, ".obsidian", "app.json")).raw).toBe('{"x":1}');
    // the staged copy is its own inode: editing it leaves the live note alone
    writeFileSync(join(staged.root, NEXT), "changed");
    expect(readFileSync(join(root, NEXT), "utf8")).toBe("# next\nthread");
  });
});
