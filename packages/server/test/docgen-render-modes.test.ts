// docgen render modes: generated regions are committed canonical-EMPTY and filled at build time, so
// a tool- or config-adding PR never rewrites (and so never conflicts on) a generated block.
//   default  fill in place      --reset  empty back to canonical      --check  assert empty + renderable
// The pure half (applyRegions) is tested with synthetic targets; the CLI half runs against a copy
// of the REAL doc tree via DOCGEN_RENDER_ROOT_OVERRIDE, so the shipped targets/markers/extractors
// are what is exercised and the working tree is never mutated.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { isCanonicalEmpty } from "../scripts/docgen/inject";
import { applyRegions, type RegionTarget } from "../scripts/docgen/render-regions";
import { makeTempDir } from "./tmp";

const doc = (body: string): string =>
  `# T\n\nprose above\n\n<!-- BEGIN GENERATED: tools -->${body}<!-- END GENERATED: tools -->\n\nprose below\n`;
const EMPTY = doc("\n\n");

function memIO(files: Record<string, string>) {
  return {
    files,
    read: (f: string): string => {
      const v = files[f];
      if (v === undefined) throw new Error(`ENOENT ${f}`);
      return v;
    },
    write: (f: string, t: string): void => {
      files[f] = t;
    },
  };
}
const target = (over: Partial<RegionTarget> = {}): RegionTarget => ({
  rel: "a.md",
  file: "a.md",
  marker: "tools",
  content: "| row |",
  ...over,
});

describe("applyRegions (pure)", () => {
  it("fill writes the rendered content and preserves prose, then is idempotent", () => {
    const io = memIO({ "a.md": EMPTY });
    const r1 = applyRegions("fill", [target()], io);
    expect(r1).toEqual({ problems: [], changed: ["a.md::tools"] });
    expect(io.files["a.md"]).toContain("| row |");
    expect(io.files["a.md"]).toContain("prose above");
    expect(io.files["a.md"]).toContain("prose below");
    const r2 = applyRegions("fill", [target()], io);
    expect(r2.changed).toEqual([]);
  });

  it("reset empties a filled region back to the canonical form", () => {
    const io = memIO({ "a.md": EMPTY });
    applyRegions("fill", [target()], io);
    const r = applyRegions("reset", [target()], io);
    expect(r.changed).toEqual(["a.md::tools"]);
    expect(io.files["a.md"]).toBe(EMPTY);
    expect(isCanonicalEmpty(io.files["a.md"] as string, "tools")).toBe(true);
  });

  it("check passes on a canonical-empty region", () => {
    expect(applyRegions("check", [target()], memIO({ "a.md": EMPTY }))).toEqual({
      problems: [],
      changed: [],
    });
  });

  it("check FAILS on a filled committed region, and never writes", () => {
    const io = memIO({ "a.md": doc("\n| stale row |\n") });
    const r = applyRegions("check", [target()], io);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatch(/a\.md \(marker: tools\).*FILLED/);
    expect(io.files["a.md"]).toContain("| stale row |");
  });

  it("check FAILS (naming the target) when a renderer produced nothing", () => {
    for (const mode of ["fill", "reset", "check"] as const) {
      const r = applyRegions(mode, [target({ content: "  \n" })], memIO({ "a.md": EMPTY }));
      expect(r.problems, mode).toHaveLength(1);
      expect(r.problems[0]).toMatch(/rendered EMPTY/);
    }
  });

  it("fails on a target whose markers are gone, naming it", () => {
    const r = applyRegions("check", [target()], memIO({ "a.md": "# no markers" }));
    expect(r.problems[0]).toMatch(/a\.md \(marker: tools\).*markers.*not found/i);
  });

  it("a whitespace-only difference inside the region is still FILLED (not canonical)", () => {
    expect(isCanonicalEmpty(doc("\n"), "tools")).toBe(false);
    expect(isCanonicalEmpty(doc("\n\n\n"), "tools")).toBe(false);
  });
});

const SERVER = fileURLToPath(new URL("..", import.meta.url));
const REPO = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");
const SCRIPT = `${SERVER}/scripts/docgen/render.ts`;

function runRender(args: string[], root?: string) {
  const r = spawnSync("bun", [SCRIPT, ...args], {
    cwd: SERVER,
    encoding: "utf8",
    env: { ...process.env, ...(root ? { DOCGEN_RENDER_ROOT_OVERRIDE: root } : {}) },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

/** A copy of the doc surfaces docgen owns, taken from the real tree. */
function copyDocTree(): string {
  const dir = makeTempDir("docgen-modes-");
  scratch.push(dir);
  for (const f of ["README.md", "ARCHITECTURE.md"]) cpSync(`${REPO}/${f}`, `${dir}/${f}`);
  mkdirSync(`${dir}/docs`, { recursive: true });
  for (const e of readdirSync(`${REPO}/docs`, { withFileTypes: true })) {
    if (e.isFile() && /\.mdx?$/i.test(e.name))
      cpSync(`${REPO}/docs/${e.name}`, `${dir}/docs/${e.name}`);
  }
  cpSync(`${REPO}/docs/wiki`, `${dir}/docs/wiki`, { recursive: true });
  cpSync(`${REPO}/docs/src/content`, `${dir}/docs/src/content`, {
    recursive: true,
    // build output, gitignored: never part of the committed surface
    filter: (src) => !/\/tools\/reference(\/|$)|decisions-index\.md$/.test(src),
  });
  return dir;
}

function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of readdirSync(root, { recursive: true }) as string[]) {
    if (!/\.mdx?$/i.test(rel)) continue;
    // Recursive readdir yields "a\\b.md" on Windows; the assertions key on "a/b.md".
    out.set(rel.replaceAll("\\", "/"), readFileSync(`${root}/${rel}`, "utf8"));
  }
  return out;
}

describe("render.ts modes against the real doc tree", () => {
  it("the COMMITTED tree passes --check (every region canonical-empty, every target renders)", () => {
    const r = runRender(["--check"]);
    expect(r.out).not.toMatch(/FILLED|EMPTY|no registered renderer/);
    expect(r.status).toBe(0);
  }, 120_000);

  it("fill -> check fails naming filled regions -> reset restores the committed bytes exactly", () => {
    const root = copyDocTree();
    const committed = snapshot(root);

    const fill = runRender([], root);
    expect(fill.status, fill.out).toBe(0);
    const filled = snapshot(root);
    // Every registered target now carries content: the catalog rows, the config table, the stats.
    expect(filled.get("docs/src/content/docs/tools/tool-catalog.md")).toMatch(/\[`read_note`\]/);
    expect(filled.get("docs/src/content/docs/configuration/config-reference.md")).toMatch(
      /`cacheDir`/,
    );
    expect(filled.get("docs/wiki/Home.md")).toMatch(/\*\*Version\*\*/);
    expect(filled.get("docs/wiki/Plugin-Bridges.md")).toMatch(/`\d+\.\d+\.\d+`/);
    expect(filled.get("docs/src/content/docs/observability/prometheus.md")).toMatch(/obsidian_tc_/);
    expect(filled.get("docs/src/content/docs/tools/error-catalog.md")).toMatch(/`forbidden`/);
    expect(filled.get("docs/src/content/docs/configuration/config-yaml.md")).toMatch(/"cacheDir"/);
    // Prose is untouched: only text between markers moved.
    for (const [rel, before] of committed) {
      const strip = (s: string): string =>
        s.replace(
          /(<!-- BEGIN GENERATED: ([\w-]+) -->)[\s\S]*?(<!-- END GENERATED: \2 -->)/g,
          "$1$3",
        );
      expect(strip(filled.get(rel) as string), rel).toBe(strip(before));
    }

    const check = runRender(["--check"], root);
    expect(check.status).toBe(1);
    expect(check.out).toMatch(/tool-catalog\.md \(marker: tools\).*FILLED/);

    const refill = runRender([], root);
    expect(snapshot(root)).toEqual(filled); // fill is idempotent
    expect(refill.status).toBe(0);

    const reset = runRender(["--reset"], root);
    expect(reset.status, reset.out).toBe(0);
    expect(snapshot(root)).toEqual(committed);
    expect(runRender(["--check"], root).status).toBe(0);
  }, 240_000);

  it("--check FAILS on an orphan marker that has no registered renderer", () => {
    const root = copyDocTree();
    const f = `${root}/docs/wiki/FAQ.md`;
    writeFileSync(
      f,
      `${readFileSync(f, "utf8")}\n<!-- BEGIN GENERATED: nobody-renders-this -->\n\n<!-- END GENERATED: nobody-renders-this -->\n`,
    );
    const r = runRender(["--check"], root);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/no registered renderer[\s\S]*FAQ\.md \(marker: nobody-renders-this\)/);
  }, 120_000);

  it("--check FAILS when a registered region lost its markers", () => {
    const root = copyDocTree();
    const f = `${root}/docs/wiki/Configuration.md`;
    writeFileSync(
      f,
      readFileSync(f, "utf8").replace(/<!-- (BEGIN|END) GENERATED: config -->/g, ""),
    );
    const r = runRender(["--check"], root);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/Configuration\.md \(marker: config\)/);
  }, 120_000);

  it("refuses --check together with --reset", () => {
    const r = runRender(["--check", "--reset"]);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/mutually exclusive/);
  });
});

describe("README / ARCHITECTURE carry prose, not a generated tool list", () => {
  // THE-469's root cause: README named none of the write tools, so reviewers concluded the write
  // surface was thin. The generated summary that guarded this is gone (it was the largest
  // conflict surface); the hand-written prose must keep naming the edit tools.
  for (const f of ["README.md", "ARCHITECTURE.md"]) {
    it(`${f} has no tools-summary region`, () => {
      expect(readFileSync(`${REPO}/${f}`, "utf8")).not.toContain("GENERATED: tools-summary");
    });
  }
  it("README names the write/edit tools explicitly and links the catalog", () => {
    const readme = readFileSync(`${REPO}/README.md`, "utf8");
    for (const name of ["patch_note", "write_note", "append_note", "update_frontmatter"]) {
      expect(readme).toContain(name);
    }
    expect(readme).toContain("/tools/tool-catalog/");
  });
});
