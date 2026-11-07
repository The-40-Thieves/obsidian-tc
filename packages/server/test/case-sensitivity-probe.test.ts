import { readdirSync, readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { detectFsCaseSensitivity } from "../src/vault/case-sensitivity";
import { makeTempDir, rmTemp } from "./tmp";

const collision = vi.hoisted(() => ({ enabled: false, path: "" }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
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
