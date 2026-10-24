// The "not installed" and version-skew hints name the install this obsidian-tc's own layout needs:
// a global install gets `npm install --global`, a project install gets `--save-exact` run in that
// project, and a layout the planner refuses keeps the two-form hint. Every case injects its install
// site, so no test reads the real install location or shells out to npm.
import { describe, expect, it } from "vitest";
import { version } from "../package.json";
import type { EmbedderInstallSite } from "../src/providers/embedder-install-plan";
import {
  embedderVersionSkew,
  localEmbedderInstallHint,
} from "../src/providers/local-embedder-registry";

const PKG = "@the-40-thieves/obsidian-tc-embedder-local";
const SPEC = `${PKG}@${version}`;

const globalSite: EmbedderInstallSite = {
  pkgDir: "/usr/lib/node_modules/obsidian-tc",
  globalRoot: "/usr/lib/node_modules",
  userAgent: "npm/10.9.0 node/v24.0.0 linux x64",
};
const localSite: EmbedderInstallSite = {
  pkgDir: "/home/u/proj/node_modules/obsidian-tc",
  exists: (p) => p === "/home/u/proj/package.json",
};
const storeSite: EmbedderInstallSite = {
  pkgDir: "/home/u/proj/node_modules/.pnpm/obsidian-tc@1.33.1/node_modules/obsidian-tc",
  exists: () => true,
};

describe("localEmbedderInstallHint — planned from this obsidian-tc's install layout", () => {
  it("a global install names npm install --global at its own version, never --save-exact", () => {
    expect(localEmbedderInstallHint(globalSite)).toBe(`npm install --global ${SPEC}`);
  });

  it("a project install names --save-exact, run in that project's directory", () => {
    expect(localEmbedderInstallHint(localSite)).toBe(
      `npm install --save-exact ${SPEC} in /home/u/proj`,
    );
  });

  it("a layout the planner refuses (a package-manager store) keeps both forms", () => {
    const hint = localEmbedderInstallHint(storeSite);
    expect(hint).toContain(`npm install --save-exact ${SPEC} in your project`);
    expect(hint).toContain(`npm install --global ${SPEC} if obsidian-tc is installed globally`);
  });
});

describe("embedderVersionSkew — the stale-pair warning names the planned install", () => {
  it("a global install is told to install --global, not --save-exact", () => {
    const warn = embedderVersionSkew("0.0.1", globalSite);
    expect(warn).toBe(
      `${PKG}@0.0.1 is installed, but this obsidian-tc is ${version}. Install the matching embedder: npm install --global ${SPEC}`,
    );
  });
});
