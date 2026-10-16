// THE-749 — pinned-version contract fixtures for the community-plugin bridges.
//
// routes.test.ts (routes.test.ts:1) covers the bridge PROTOCOL — every handler answers, status
// codes, the commands/probe families. This file covers something routes.test.ts cannot: whether
// each bridge still parses the REAL response shape of the community plugin it talks to.
//
// requireApi (../src/routes/envelope.ts:57) detects a MISSING `api` -> plugin_unreachable, but a
// method that is PRESENT with a changed return shape passes straight through `as T` with zero
// runtime checking. A bridge that duck-types `.value.values` and gets handed `.value.rows` instead
// does not throw — it silently defaults to `[]` via `??` and answers `ok:true` with wrong data.
// The existing shape-probe (THE-282, src/main.ts) only checks Obsidian CORE internals
// (vault/workspace/metadataCache); it never touches a community plugin's `api`.
//
// Each `describe` block below:
//   1. States the SOURCE the fixture was pinned against (published types/docs + version, or "NOT
//      FOUND in current published source" when a shape could not be corroborated anywhere).
//   2. A POSITIVE test: the real, sourced shape parses to the expected envelope.
//   3. Where the bridge duck-types a field the plugin could plausibly rename, a NEGATIVE test that
//      feeds the plausibly-renamed shape through and pins down what actually happens today. None
//      of these seven bridges runtime-validates a shape, so every negative test below documents a
//      SILENT wrong-data or SILENT empty-result outcome, not a typed error — that is the exact gap
//      THE-749 exists to make visible. If a future change adds real validation, the assertion here
//      will flip from "silently wrong" to "typed error" and this test will fail — that flip IS the
//      tripwire, and updating this test in step with such a change is the intended workflow.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TFile } from "obsidian";
import { describe, expect, it } from "vitest";
import { buildDataviewRoutes } from "../src/routes/dataview";
import { buildExcalidrawRoutes } from "../src/routes/excalidraw";
import { buildGitRoutes } from "../src/routes/git";
import { buildMakemdRoutes } from "../src/routes/makemd";
import { buildOcrRoutes } from "../src/routes/ocr";
import { buildQuickAddRoutes } from "../src/routes/quickadd";
import { buildTasksRoutes } from "../src/routes/tasks";
import { buildTemplaterRoutes } from "../src/routes/templater";
import type { BridgeReq, BridgeRes, InternalApp, RouteDef } from "../src/routes/types";

function makeRes() {
  const seen: { status?: number; body?: unknown; calls: number } = { calls: 0 };
  const res: BridgeRes = {
    status(code: number) {
      seen.status = code;
      return res;
    },
    json(body: unknown) {
      seen.body = body;
      seen.calls += 1;
    },
  };
  return { res, seen };
}
const req = (body?: unknown): BridgeReq => ({ body });

/** Build a real `TFile` instance (THE-964: fileByPath narrows with `instanceof TFile`, so a
 *  plain object literal no longer resolves through `getAbstractFileByPath`). */
function tfile(fields: { path: string; basename: string; extension: string }): TFile {
  return Object.assign(new TFile(), fields);
}

/**
 * A minimal InternalApp whose community-plugin registry and vault are fully controllable per
 * test. `plugins` keys are the REAL Obsidian plugin ids (CAP_IDS values in ../src/routes/types.ts,
 * e.g. "text-extractor", "templater-obsidian") — not the bridge's short capability key.
 */
function fakeApp(
  plugins: Record<string, Record<string, unknown>> = {},
  files: Record<string, TFile> = {},
  markdownFiles: { path: string; basename: string }[] = [],
): InternalApp {
  return {
    plugins: { plugins },
    internalPlugins: { plugins: {} },
    commands: { listCommands: () => [], executeCommandById: () => false },
    vault: {
      getAbstractFileByPath: (p: string) => files[p] ?? null,
      getMarkdownFiles: () => markdownFiles,
      getName: () => "TestVault",
      adapter: { getBasePath: () => "/tmp/TestVault" },
      read: async () => "",
      modify: async () => {},
      create: async () => {},
    },
  } as unknown as InternalApp;
}

const findRoute = (defs: RouteDef[], path: string) => {
  const d = defs.find((r) => r.path === path);
  if (!d) throw new Error(`no route ${path}`);
  return d.handler;
};

// ---------------------------------------------------------------------------------------------
describe("obsidian-git — /git/status path basis", () => {
  const parentStatus = {
    changed: [
      {
        path: "Vault/Notes/a.md",
        from: "Vault/Notes/old.md",
        workingDir: "R",
        index: "",
        vaultPath: "Notes/a.md",
      },
      { path: "Vault/.trash/secret.md", workingDir: "M", index: "" },
      { path: "outside-vault/.env", workingDir: "M", index: "" },
      { path: "VaultX/a.md", workingDir: "M", index: "" },
      { path: "Vault/Notes/b.md", from: "outside-vault/old.md", workingDir: "R", index: "" },
    ],
    staged: [
      { path: "Vault/Notes/a.md", index: "A" },
      { path: "outside-vault/.env", index: "A" },
    ],
    conflicted: ["Vault/Notes/a.md", "outside-vault/.env"],
  };

  const gitApp = (options: {
    status: unknown;
    repositoryPath?: string;
    vaultPath?: string;
    basePath?: string;
    exposeBasePath?: boolean;
    getDiffString?: (path: string, staged?: boolean) => Promise<unknown>;
    stage?: (path: string, relativeToVault: boolean) => Promise<unknown>;
  }) => {
    const basePath = options.basePath;
    const app = fakeApp({
      "obsidian-git": {
        settings: basePath === undefined ? {} : { basePath },
        gitManager: {
          status: async () => options.status,
          ...(options.getDiffString ? { getDiffString: options.getDiffString } : {}),
          ...(options.stage ? { stage: options.stage } : {}),
          ...(options.repositoryPath === undefined
            ? {}
            : { absoluteRepoPath: options.repositoryPath }),
        },
      },
    });
    app.vault.adapter =
      (options.exposeBasePath ?? true)
        ? ({ getBasePath: () => options.vaultPath } as unknown as typeof app.vault.adapter)
        : ({} as typeof app.vault.adapter);
    return app;
  };

  it("maps a parent repository into the child vault and drops outside-vault paths", async () => {
    const app = gitApp({
      status: parentStatus,
      repositoryPath: "/r",
      vaultPath: "/r/Vault",
      basePath: "",
    });
    const { res, seen } = makeRes();

    await findRoute(buildGitRoutes(app), "/git/status")(req({}), res);

    expect(seen.body).toEqual({
      ok: true,
      result: {
        paths_relative_to_vault: true,
        changed: [
          {
            path: "Notes/a.md",
            from: "Notes/old.md",
            working_dir: "R",
            index: "",
          },
          { path: ".trash/secret.md", working_dir: "M", index: "" },
        ],
        staged: [{ path: "Notes/a.md", index: "A" }],
        conflicted: ["Notes/a.md"],
      },
    });
  });

  it("prefixes the repository path when the repository is a child of the vault", async () => {
    const status = {
      changed: [{ path: "a.md", workingDir: "M", index: "" }],
      staged: [{ path: "a.md", index: "A" }],
      conflicted: ["a.md"],
    };
    const app = gitApp({
      status,
      repositoryPath: "/r/sub",
      vaultPath: "/r",
      basePath: "sub",
    });
    const { res, seen } = makeRes();

    await findRoute(buildGitRoutes(app), "/git/status")(req({}), res);

    expect(seen.body).toEqual({
      ok: true,
      result: {
        paths_relative_to_vault: true,
        changed: [{ path: "sub/a.md", working_dir: "M", index: "" }],
        staged: [{ path: "sub/a.md", index: "A" }],
        conflicted: ["sub/a.md"],
      },
    });
  });

  it("leaves paths unchanged when the repository root is the vault root", async () => {
    const rootStatus = {
      changed: [{ path: "Notes/a.md", workingDir: "M", index: "" }],
      staged: [{ path: ".trash/secret.md", index: "A" }],
      conflicted: ["Notes/a.md"],
    };
    const app = gitApp({
      status: rootStatus,
      repositoryPath: "/r",
      vaultPath: "/r",
      basePath: "",
    });
    const { res, seen } = makeRes();

    await findRoute(buildGitRoutes(app), "/git/status")(req({}), res);

    expect(seen.body).toEqual({
      ok: true,
      result: {
        paths_relative_to_vault: true,
        changed: [{ path: "Notes/a.md", working_dir: "M", index: "" }],
        staged: rootStatus.staged,
        conflicted: rootStatus.conflicted,
      },
    });
  });

  it("fails closed on desktop when older obsidian-git has basePath but no absoluteRepoPath", async () => {
    const app = gitApp({ status: parentStatus, vaultPath: "/r/Vault", basePath: "" });
    const { res, seen } = makeRes();

    await findRoute(buildGitRoutes(app), "/git/status")(req({}), res);

    expect(seen.body).toMatchObject({
      ok: false,
      code: "plugin_incompatible",
      message: expect.stringContaining("repository path"),
      details: {
        plugin: "git",
        hint: expect.stringContaining("Update obsidian-git"),
      },
    });
  });

  it("uses the settings basePath on mobile when the adapter has no getBasePath", async () => {
    const status = {
      changed: [{ path: "a.md", working_dir: "M", index: "" }],
      staged: [{ path: "a.md", index: "A" }],
      conflicted: ["a.md"],
    };
    const app = gitApp({
      status,
      basePath: "sub",
      exposeBasePath: false,
    });
    const { res, seen } = makeRes();

    await findRoute(buildGitRoutes(app), "/git/status")(req({}), res);

    expect(seen.body).toEqual({
      ok: true,
      result: {
        paths_relative_to_vault: true,
        changed: [{ path: "sub/a.md", working_dir: "M", index: "" }],
        staged: [{ path: "sub/a.md", index: "A" }],
        conflicted: ["sub/a.md"],
      },
    });
  });

  it("preserves working_dir from older obsidian-git status rows", async () => {
    const app = gitApp({
      status: { changed: [{ path: "a.md", working_dir: "M", index: "" }] },
      repositoryPath: "/r",
      vaultPath: "/r",
      basePath: "",
    });
    const { res, seen } = makeRes();

    await findRoute(buildGitRoutes(app), "/git/status")(req({}), res);

    expect(seen.body).toMatchObject({
      ok: true,
      result: { changed: [{ path: "a.md", working_dir: "M", index: "" }] },
    });
  });

  it("fails closed when the vault adapter cannot report its base path", async () => {
    const app = gitApp({
      status: parentStatus,
      repositoryPath: "/r",
      vaultPath: "/r/Vault",
      basePath: "",
      exposeBasePath: false,
    });
    const { res, seen } = makeRes();

    await findRoute(buildGitRoutes(app), "/git/status")(req({}), res);

    expect(seen.body).toMatchObject({
      ok: false,
      code: "plugin_incompatible",
      message: expect.stringContaining("vault base path"),
    });
  });
});

describe("obsidian-git — path comparison: case, Unicode, realpath and settings reload", () => {
  const rows = (path: string) => ({
    changed: [{ path, workingDir: "M", index: "" }],
    staged: [],
    conflicted: [],
  });

  const gitApp = (options: {
    repositoryPath: string;
    vaultPath: string;
    status?: unknown;
    revparse?: (args: string[]) => Promise<unknown>;
  }) => {
    const app = fakeApp({
      "obsidian-git": {
        gitManager: {
          absoluteRepoPath: options.repositoryPath,
          status: async () => options.status,
          ...(options.revparse ? { git: { revparse: options.revparse } } : {}),
        },
      },
    });
    app.vault.adapter = {
      getBasePath: () => options.vaultPath,
    } as unknown as typeof app.vault.adapter;
    return app;
  };

  it.each(["darwin", "win32"] as const)(
    "case-folds the vault prefix on %s and keeps the row's spelling below the vault root",
    async (platform) => {
      const app = gitApp({
        repositoryPath: "/r",
        vaultPath: "/r/Vault",
        status: rows("vault/Notes/A.md"),
      });
      const { res, seen } = makeRes();

      await findRoute(buildGitRoutes(app, platform), "/git/status")(req({}), res);

      expect(seen.body).toEqual({
        ok: true,
        result: {
          paths_relative_to_vault: true,
          changed: [{ path: "Notes/A.md", working_dir: "M", index: "" }],
          staged: [],
          conflicted: [],
        },
      });
    },
  );

  it("keeps the vault prefix comparison case-sensitive on linux", async () => {
    const app = gitApp({
      repositoryPath: "/r",
      vaultPath: "/r/Vault",
      status: rows("vault/Notes/A.md"),
    });
    const { res, seen } = makeRes();

    await findRoute(buildGitRoutes(app, "linux"), "/git/status")(req({}), res);

    expect(seen.body).toEqual({
      ok: true,
      result: { paths_relative_to_vault: true, changed: [], staged: [], conflicted: [] },
    });
  });

  it.each(["linux", "darwin"] as const)(
    "matches an NFD vault folder name against git's NFC spelling on %s",
    async (platform) => {
      const app = gitApp({
        repositoryPath: "/r",
        vaultPath: "/r/Vault/Café",
        status: rows("Vault/Café/a.md"),
      });
      const { res, seen } = makeRes();

      await findRoute(buildGitRoutes(app, platform), "/git/status")(req({}), res);

      expect(seen.body).toEqual({
        ok: true,
        result: {
          paths_relative_to_vault: true,
          changed: [{ path: "a.md", working_dir: "M", index: "" }],
          staged: [],
          conflicted: [],
        },
      });
    },
  );

  it("refuses status while the git instance does not sit at the repository root", async () => {
    const calls: string[][] = [];
    const app = gitApp({
      repositoryPath: "/r/Vault",
      vaultPath: "/r/Vault",
      status: rows("secret.env"),
      revparse: async (args) => {
        calls.push(args);
        return "../\n";
      },
    });
    const { res, seen } = makeRes();

    await findRoute(buildGitRoutes(app, "linux"), "/git/status")(req({}), res);

    expect(calls).toEqual([["--show-cdup"]]);
    expect(seen.body).toMatchObject({
      ok: false,
      code: "git_error",
      message: expect.stringContaining("reconfigured"),
    });
    expect(seen.body).not.toHaveProperty("result");
  });

  it("maps status when the git instance sits at the repository root", async () => {
    const app = gitApp({
      repositoryPath: "/r/Vault",
      vaultPath: "/r/Vault",
      status: rows("secret.env"),
      revparse: async () => "\n",
    });
    const { res, seen } = makeRes();

    await findRoute(buildGitRoutes(app, "linux"), "/git/status")(req({}), res);

    expect(seen.body).toEqual({
      ok: true,
      result: {
        paths_relative_to_vault: true,
        changed: [{ path: "secret.env", working_dir: "M", index: "" }],
        staged: [],
        conflicted: [],
      },
    });
  });

  it("fails closed with git_error when the git instance cannot report its top level", async () => {
    const app = gitApp({
      repositoryPath: "/r/Vault",
      vaultPath: "/r/Vault",
      status: rows("secret.env"),
      revparse: async () => {
        throw new Error("not a git repository");
      },
    });
    const { res, seen } = makeRes();

    await findRoute(buildGitRoutes(app, "linux"), "/git/status")(req({}), res);

    expect(seen.body).toMatchObject({ ok: false, code: "git_error" });
  });

  it("maps a symlinked vault through its real location on linux", async () => {
    const dir = mkdtempSync(join(tmpdir(), "git-route-"));
    try {
      const repo = join(dir, "repo");
      mkdirSync(join(repo, "Vault"), { recursive: true });
      const link = join(dir, "vault-link");
      symlinkSync(join(repo, "Vault"), link, "junction");
      const app = gitApp({
        repositoryPath: repo,
        vaultPath: link,
        status: rows("Vault/a.md"),
      });
      const { res, seen } = makeRes();

      await findRoute(buildGitRoutes(app, "linux"), "/git/status")(req({}), res);

      expect(seen.body).toEqual({
        ok: true,
        result: {
          paths_relative_to_vault: true,
          changed: [{ path: "a.md", working_dir: "M", index: "" }],
          staged: [],
          conflicted: [],
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("obsidian-git — vault paths become literal repository pathspecs", () => {
  const gitApp = (options: {
    repositoryPath: string;
    vaultPath: string;
    basePath: string;
    getDiffString?: (path: string, staged?: boolean) => Promise<unknown>;
    stage?: (path: string, relativeToVault: boolean) => Promise<unknown>;
  }) => {
    const app = fakeApp({
      "obsidian-git": {
        settings: { basePath: options.basePath },
        gitManager: {
          absoluteRepoPath: options.repositoryPath,
          ...(options.getDiffString ? { getDiffString: options.getDiffString } : {}),
          ...(options.stage ? { stage: options.stage } : {}),
        },
      },
    });
    app.vault.adapter = {
      getBasePath: () => options.vaultPath,
    } as unknown as typeof app.vault.adapter;
    return app;
  };

  it("maps a parent-repository diff path and makes it literal", async () => {
    const calls: Array<[string, boolean | undefined]> = [];
    const app = gitApp({
      repositoryPath: "/r",
      vaultPath: "/r/Vault",
      basePath: "",
      getDiffString: async (path, staged) => {
        calls.push([path, staged]);
        return "diff";
      },
    });
    const { res, seen } = makeRes();

    await findRoute(buildGitRoutes(app), "/git/diff")(
      req({ path: "Notes/a.md", staged: true }),
      res,
    );

    expect(seen.body).toEqual({ ok: true, result: { diff: "diff" } });
    expect(calls).toEqual([[":(literal)Vault/Notes/a.md", true]]);
  });

  it("maps a child-repository diff path and rejects paths outside that child", async () => {
    const calls: string[] = [];
    const app = gitApp({
      repositoryPath: "/r/sub",
      vaultPath: "/r",
      basePath: "sub",
      getDiffString: async (path) => {
        calls.push(path);
        return "diff";
      },
    });
    const route = findRoute(buildGitRoutes(app), "/git/diff");
    const accepted = makeRes();
    const refused = makeRes();

    await route(req({ path: "sub/a.md" }), accepted.res);
    await route(req({ path: "other/a.md" }), refused.res);

    expect(accepted.seen.body).toEqual({ ok: true, result: { diff: "diff" } });
    expect(refused.seen.body).toMatchObject({ ok: false, code: "invalid_input" });
    expect(calls).toEqual([":(literal)a.md"]);
  });

  it("passes a question-mark filename to diff as a literal pathspec", async () => {
    const calls: string[] = [];
    const app = gitApp({
      repositoryPath: "/r",
      vaultPath: "/r",
      basePath: "",
      getDiffString: async (path) => {
        calls.push(path);
        return "diff";
      },
    });
    const { res } = makeRes();

    await findRoute(buildGitRoutes(app), "/git/diff")(
      req({ path: "?obsidian/plugins/obsidian-local-rest-api/data.json", staged: true }),
      res,
    );

    expect(calls).toEqual([":(literal)?obsidian/plugins/obsidian-local-rest-api/data.json"]);
  });

  it("passes a star filename to stage as a literal repository pathspec", async () => {
    const calls: Array<[string, boolean]> = [];
    const app = gitApp({
      repositoryPath: "/r",
      vaultPath: "/r",
      basePath: "",
      stage: async (path, relativeToVault) => {
        calls.push([path, relativeToVault]);
      },
    });
    const { res, seen } = makeRes();

    await findRoute(buildGitRoutes(app), "/git/stage")(req({ paths: ["*"] }), res);

    expect(seen.body).toEqual({ ok: true, result: { staged: 1 } });
    expect(calls).toEqual([[":(literal)*", false]]);
  });

  it("passes mapped filenames unchanged to the exact-path mobile backend", async () => {
    const diffs: string[] = [];
    const stages: Array<[string, boolean]> = [];
    const app = fakeApp({
      "obsidian-git": {
        settings: { basePath: "sub" },
        gitManager: {
          getDiffString: async (path: string) => {
            diffs.push(path);
            return "diff";
          },
          stage: async (path: string, relativeToVault: boolean) => {
            stages.push([path, relativeToVault]);
          },
        },
      },
    });
    app.vault.adapter = {} as typeof app.vault.adapter;

    await findRoute(buildGitRoutes(app), "/git/diff")(req({ path: "sub/?note.md" }), makeRes().res);
    await findRoute(buildGitRoutes(app), "/git/stage")(req({ paths: ["sub/*"] }), makeRes().res);

    expect(diffs).toEqual(["?note.md"]);
    expect(stages).toEqual([["*", false]]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("dataview — /dataview/dql, /dataview/eval", () => {
  // SOURCE: Dataview's own published API code-reference
  // (github.com/blacksmithgu/obsidian-dataview/blob/master/docs/docs/api/code-reference.md),
  // fetched via context7 (/blacksmithgu/obsidian-dataview) 2026-08-20, current `master`.
  //   await dv.query("TABLE ...") => { successful: true, value: { type: "table", headers: [...],
  //                                                                  values: [[...], [...]] } }
  //   dv.evaluate("2 + 2")        => Successful { value: 4 }   (synchronous, matches the bridge's
  //                                                              own `Promise<T> | T` typing)
  const realQuerySuccess = {
    successful: true,
    value: {
      type: "table",
      headers: ["file.name", "value"],
      values: [
        ["A", 1],
        ["B", 2],
      ],
    },
  };

  it("parses a real successful TABLE query into the bridge envelope", async () => {
    const app = fakeApp({ dataview: { api: { query: async () => realQuerySuccess } } });
    const { res, seen } = makeRes();
    await findRoute(buildDataviewRoutes(app), "/dataview/dql")(req({ dql: "TABLE x" }), res);
    expect(seen.body).toMatchObject({
      ok: true,
      result: {
        headers: ["file.name", "value"],
        rows: [
          ["A", 1],
          ["B", 2],
        ],
      },
    });
  });

  it("parses a real successful evaluate() into the bridge envelope", async () => {
    const app = fakeApp({
      dataview: { api: { evaluate: () => ({ successful: true, value: 4 }) } },
    });
    const { res, seen } = makeRes();
    await findRoute(buildDataviewRoutes(app), "/dataview/eval")(req({ expression: "2 + 2" }), res);
    expect(seen.body).toMatchObject({ ok: true, result: { value: 4, type: "number" } });
  });

  it("TRIPWIRE: a plausible values -> rows rename is silently mis-parsed, not detected", async () => {
    // Same successful envelope, but Dataview renamed the inner field the ticket names as its own
    // worked example. dataview.ts:42 reads `r.value?.values` with a `?? []` fallback — no check
    // that the field it expects is actually there.
    const renamed = {
      successful: true,
      value: { type: "table", headers: ["file.name", "value"], rows: [["A", 1]] },
    };
    const app = fakeApp({ dataview: { api: { query: async () => renamed } } });
    const { res, seen } = makeRes();
    await findRoute(buildDataviewRoutes(app), "/dataview/dql")(req({ dql: "TABLE x" }), res);
    // Still ok:true — no error surfaces anywhere — but the real row Dataview returned is GONE.
    expect(seen.body).toMatchObject({
      ok: true,
      result: { headers: ["file.name", "value"], rows: [] },
    });
  });
});

// ---------------------------------------------------------------------------------------------
describe("quickadd — /quickadd/actions", () => {
  // SOURCE: QuickAdd's published `IChoice` interface
  // (github.com/chhoumann/quickadd/blob/master/src/types/choices/ITemplateChoice.ts), fetched via
  // context7 (/chhoumann/quickadd) 2026-08-20, current `master`:
  //   interface IChoice { name: string; id: string; type: ChoiceType; command: boolean; icon?: string }
  const realChoices = [
    { id: "c1", name: "New daily note", type: "Template", command: false },
    { id: "c2", name: "Quick capture", type: "Capture", command: true, icon: "star" },
  ];

  it("parses real settings.choices into the actions envelope", () => {
    const app = fakeApp({ quickadd: { settings: { choices: realChoices } } });
    const { res, seen } = makeRes();
    findRoute(buildQuickAddRoutes(app), "/quickadd/actions")(req({}), res);
    expect(seen.body).toMatchObject({
      ok: true,
      result: {
        items: [
          { name: "New daily note", type: "Template" },
          { name: "Quick capture", type: "Capture" },
        ],
      },
    });
  });

  it("TRIPWIRE: a plausible name -> label rename is silently mis-parsed, not detected", () => {
    // quickadd.ts:22 reads `c.name` with no presence check — a renamed field yields an item with
    // no name at all rather than an error, so a caller can no longer tell which choice is which.
    const renamed = [{ id: "c1", label: "New daily note", type: "Template", command: false }];
    const app = fakeApp({ quickadd: { settings: { choices: renamed } } });
    const { res, seen } = makeRes();
    findRoute(buildQuickAddRoutes(app), "/quickadd/actions")(req({}), res);
    const items = (seen.body as { result: { items: { name?: string; type: string }[] } }).result
      .items;
    expect(items).toHaveLength(1);
    expect(items[0]?.name).toBeUndefined();
    expect(items[0]?.type).toBe("Template");
  });
});

// ---------------------------------------------------------------------------------------------
describe("text-extractor (ocr) — /ocr/attachment", () => {
  // SOURCE: Text Extractor's own published README (github.com/scambier/obsidian-text-extractor,
  // "Using Text Extractor as a dependency for your plugin"), fetched 2026-08-20, manifest.json
  // pins the current release at v0.7.0:
  //   type TextExtractorApi = {
  //     extractText: (file: TFile) => Promise<string>
  //     canFileBeExtracted: (filePath: string) => boolean
  //     isInCache: (file: TFile) => Promise<boolean>
  //   }
  const file = tfile({ path: "Scans/receipt.png", basename: "receipt", extension: "png" });

  it("parses a real extractText()/isInCache() pair into the bridge envelope", async () => {
    const app = fakeApp(
      {
        "text-extractor": {
          api: {
            extractText: async () => "Total: $42.00",
            isInCache: async () => true,
          },
        },
      },
      { "Scans/receipt.png": file },
    );
    const { res, seen } = makeRes();
    await findRoute(buildOcrRoutes(app), "/ocr/attachment")(req({ path: file.path }), res);
    expect(seen.body).toMatchObject({
      ok: true,
      result: { path: file.path, text: "Total: $42.00", cached: true },
    });
  });

  it("TRIPWIRE: extractText() resolving an object instead of a string is silently forwarded", async () => {
    // ocr.ts:29 assigns `api.extractText(file)`'s resolved value straight to `result.text` with no
    // `typeof` check. A plausible future version adding OCR confidence scores (`{text, confidence}`
    // instead of a bare string) produces ok:true with `result.text` holding an OBJECT, not a
    // string — a shape violation of the documented envelope with no error anywhere.
    const app = fakeApp(
      {
        "text-extractor": {
          api: {
            extractText: async () => ({ text: "Total: $42.00", confidence: 0.92 }) as unknown,
            isInCache: async () => false,
          },
        },
      },
      { "Scans/receipt.png": file },
    );
    const { res, seen } = makeRes();
    await findRoute(buildOcrRoutes(app), "/ocr/attachment")(req({ path: file.path }), res);
    const result = (seen.body as { ok: boolean; result: { text: unknown } }).result;
    expect((seen.body as { ok: boolean }).ok).toBe(true);
    expect(typeof result.text).toBe("object");
  });
});

// ---------------------------------------------------------------------------------------------
describe("templater — /templater/list, /templater/execute", () => {
  // SOURCE: Templater's published Settings interface
  // (github.com/silentvoid13/templater/blob/master/src/settings/Settings.ts) plus a live
  // test-vault data.json snapshot in the same repo, fetched via context7 (/silentvoid13/templater)
  // 2026-08-20, current `master`: `templates_folder: string`. create_new_note_from_template's
  // signature (src/core/Templater.ts, same fetch):
  //   async create_new_note_from_template(template, folder?, filename?, open_new_note = true):
  //     Promise<TFile | undefined>
  // TFile fields (`path`, `basename`, `extension`) are Obsidian core, not Templater-specific.
  const md = [
    { path: "Templates/Daily.md", basename: "Daily" },
    { path: "Notes/Foo.md", basename: "Foo" },
  ];

  it("parses real settings.templates_folder into the list envelope", () => {
    const app = fakeApp(
      { "templater-obsidian": { settings: { templates_folder: "Templates" } } },
      {},
      md,
    );
    const { res, seen } = makeRes();
    findRoute(buildTemplaterRoutes(app), "/templater/list")(req({}), res);
    expect(seen.body).toMatchObject({
      ok: true,
      result: { items: [{ path: "Templates/Daily.md", name: "Daily" }] },
    });
  });

  it("parses a real create_new_note_from_template() TFile result into the execute envelope", async () => {
    const created = tfile({
      path: "Journal/2026-08-20.md",
      basename: "2026-08-20",
      extension: "md",
    });
    const app = fakeApp(
      {
        "templater-obsidian": {
          templater: { create_new_note_from_template: async () => created },
        },
      },
      {
        "Templates/Daily.md": tfile({
          path: "Templates/Daily.md",
          basename: "Daily",
          extension: "md",
        }),
      },
    );
    const { res, seen } = makeRes();
    await findRoute(buildTemplaterRoutes(app), "/templater/execute")(
      req({ template: "Templates/Daily.md", target: "Journal/2026-08-20" }),
      res,
    );
    expect(seen.body).toMatchObject({
      ok: true,
      result: { template: "Templates/Daily.md", target: "Journal/2026-08-20.md" },
    });
  });

  it("TRIPWIRE: a plausible templates_folder -> templateFolder rename silently empties the list", () => {
    // templater.ts:17 reads `settings?.templates_folder` with no presence check. A camelCase drift
    // in the real settings key yields an EMPTY items list, indistinguishable from "no templates
    // configured" — not an error.
    const app = fakeApp(
      { "templater-obsidian": { settings: { templateFolder: "Templates" } } },
      {},
      md,
    );
    const { res, seen } = makeRes();
    findRoute(buildTemplaterRoutes(app), "/templater/list")(req({}), res);
    expect(seen.body).toMatchObject({ ok: true, result: { items: [] } });
  });
});

// ---------------------------------------------------------------------------------------------
describe("make.md — /makemd/spaces, /makemd/query", () => {
  // SOURCE: make.md's own published `IAPI` interface (github.com/Make-md/makemd,
  // src/shared/types/api.ts, implemented by `class API implements IAPI` in
  // src/core/superstate/api.ts), read directly from the repo 2026-08-20, current `main`.
  //
  // FINDING, not assumed: the real, current IAPI exposes `frame`, `properties`, `path`,
  // `commands`, `buttonCommand`, `table`, `context`, `date` — there is no `spaces()` or `query()`
  // method anywhere on it. makemd.ts's `spaces?: () => unknown[]` / `query?: (id, filter) =>
  // unknown` interfaces (makemd.ts:11, makemd.ts:20) do not correspond to any method this plugin's
  // current published API actually has. This could not be corroborated against any documented
  // shape for those two names, so no positive fixture is fabricated for what `spaces`/`query`
  // would return if called — that needs a one-time live-vault capture (or confirmation this
  // bridge targets a pre-rewrite version of the plugin) before it can be pinned honestly. What
  // CAN be pinned is what the bridge does when handed the real, current API surface.
  //
  // THE-860: re-verified the same finding against the CURRENT published main (cb9ca90, v1.3.5,
  // 2026-08-20) and confirmed IAPI has had neither method since at least v1.0.1 (2024-12-27) — the
  // capability is genuinely gone, not renamed. Both routes below now fail loud
  // (`plugin_unreachable`) instead of /spaces silently degrading to `[]`; see makemd.ts.
  const realCurrentApi = {
    frame: { update: () => {} },
    properties: { color: () => "", sticker: () => undefined, value: () => "" },
    path: {
      label: () => undefined,
      thumbnail: () => undefined,
      open: () => {},
      create: () => {},
      setProperty: () => {},
      contextMenu: () => {},
    },
    commands: { run: () => {}, formula: () => {} },
    buttonCommand: () => {},
    table: {
      select: async () => undefined,
      update: () => {},
      insert: async () => {},
      create: () => {},
      open: async () => {},
      contextMenu: async () => {},
    },
    context: { select: async () => undefined, update: () => {}, insert: async () => {} },
    date: {
      parse: () => new Date(0),
      daysInMonth: () => 30,
      format: () => "",
      component: () => undefined,
      offset: () => new Date(0),
      now: () => new Date(0),
      range: () => [],
    },
  };

  it("spaces(): a real current api object IS detected as plugin_unreachable (THE-860)", () => {
    // Fixed by THE-860: makemd.ts now checks `typeof api.spaces === "function"` before calling and
    // fails loud, mirroring /query's existing guard, instead of silently degrading to `[]`.
    const app = fakeApp({ "make-md": { api: realCurrentApi } });
    const { res, seen } = makeRes();
    findRoute(buildMakemdRoutes(app), "/makemd/spaces")(req({}), res);
    expect(seen.body).toMatchObject({ ok: false, code: "plugin_unreachable" });
  });

  it("query(): a real current api object IS detected as plugin_unreachable", () => {
    // /query has always explicitly checked `if (!api.query)` (makemd.ts) before calling — so this
    // path surfaces a typed error, same as /spaces now does post-THE-860.
    const app = fakeApp({ "make-md": { api: realCurrentApi } });
    const { res, seen } = makeRes();
    findRoute(buildMakemdRoutes(app), "/makemd/query")(req({ space_id: "s1" }), res);
    expect(seen.body).toMatchObject({ ok: false, code: "plugin_unreachable" });
  });
});

// ---------------------------------------------------------------------------------------------
describe("excalidraw and tasks — no plugin-API return shape to pin", () => {
  // Verified against current source, not assumed: neither bridge calls a method on the community
  // plugin's `api` at all, so THE-749's "changed RETURN shape passes silently" failure mode does
  // not apply to either — there is no return value from the plugin being parsed in the first
  // place. Documented here (rather than silently omitted) per the ticket's own instruction to
  // verify the premise against current code first.

  it("excalidraw: only checks plugin PRESENCE, then reads/writes the vault file directly (excalidraw.ts:15,30) — never touches `.api`", async () => {
    const file = tfile({
      path: "Draw.excalidraw.md",
      basename: "Draw.excalidraw",
      extension: "md",
    });
    const app = fakeApp(
      { "obsidian-excalidraw-plugin": { api: "anything — not even an object" as unknown } },
      { "Draw.excalidraw.md": file },
    );
    const { res, seen } = makeRes();
    await findRoute(buildExcalidrawRoutes(app), "/excalidraw/read")(
      req({ path: "Draw.excalidraw.md" }),
      res,
    );
    expect(seen.body).toMatchObject({ ok: true, result: { path: "Draw.excalidraw.md" } });
  });

  it("tasks: always answers plugin_unreachable regardless of what the plugin exposes (tasks.ts:15-22) — no API is ever called", () => {
    const app = fakeApp({ "obsidian-tasks-plugin": { api: { filter: () => ["not consulted"] } } });
    const { res, seen } = makeRes();
    findRoute(buildTasksRoutes(app), "/tasks/filter")(req({}), res);
    expect(seen.body).toMatchObject({ ok: false, code: "plugin_unreachable" });
  });
});
