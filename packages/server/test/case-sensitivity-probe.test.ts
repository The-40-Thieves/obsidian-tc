import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { detectFsCaseSensitivity } from "../src/vault/case-sensitivity";
import { makeTempDir, rmTemp } from "./tmp";

const collision = vi.hoisted(() => ({ enabled: false, path: "", readOnly: false }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if (collision.readOnly && String(args[0]).includes(".obtc-CaSe-"))
        throw Object.assign(new Error("read-only vault"), { code: "EACCES" });
      if (collision.enabled && String(args[0]).includes(".obtc-CaSe-")) {
        collision.path = String(args[0]);
        fs.writeFileSync(args[0], "existing file");
      }
      return fs.writeFileSync(...args);
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  collision.enabled = false;
  collision.path = "";
  collision.readOnly = false;
  for (const root of roots.splice(0)) rmTemp(root);
});

it("removes only the probe file it created", () => {
  const root = makeTempDir("case-probe-");
  roots.push(root);
  expect(typeof detectFsCaseSensitivity(root)).toBe("boolean");
  expect(readdirSync(root).filter((name) => name.startsWith(".obtc-CaSe-"))).toEqual([]);
});

it("does not overwrite or delete an existing file at the probe name", () => {
  const root = makeTempDir("case-probe-collision-");
  roots.push(root);
  collision.enabled = true;
  detectFsCaseSensitivity(root);
  expect(collision.path).not.toBe("");
  expect(readFileSync(collision.path, "utf8")).toBe("existing file");
});

// The no-write fallback must answer for the ROOT's own lookups. The root's name looked up in its
// parent only describes the parent, which can differ (NTFS and ext4 casefold are per-directory).
it("an unwritable, empty root is unknown rather than its parent's answer", () => {
  const root = makeTempDir("case-probe-readonly-empty-");
  roots.push(root);
  collision.readOnly = true;
  expect(detectFsCaseSensitivity(root)).toBeNull();
});

it("an unwritable root is probed through an entry it already holds", () => {
  const root = makeTempDir("case-probe-readonly-");
  roots.push(root);
  writeFileSync(join(root, "Existing-Note.md"), "");
  let folds: boolean;
  try {
    statSync(join(root, "eXISTING-nOTE.MD"));
    folds = true;
  } catch {
    folds = false;
  }
  collision.readOnly = true;
  expect(detectFsCaseSensitivity(root)).toBe(folds);
});
