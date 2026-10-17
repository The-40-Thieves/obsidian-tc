// The Datacore query route flattens each frontmatter value into JSON. A Datacore Link (`{ path,
// type, display, subpath, embed }`) must reach the server as a link OBJECT naming the note it
// resolves to: the server's read-ACL filter judges `{ path, type }` shapes, so a link flattened to
// the string "[[path|display]]" would skip the path check entirely. An unresolvable link names no
// note, so it keeps its string form.

import { TFile } from "obsidian";
import { describe, expect, it } from "vitest";
import { buildDatacoreRoutes } from "../src/routes/datacore";
import type { BridgeReq, BridgeRes, InternalApp, RouteDef } from "../src/routes/types";

interface Answer {
  status?: number;
  body?: { ok: boolean; result?: { items: { fields: Record<string, unknown> }[] } };
}

/** A vault holding one note per entry of `notes`, reachable by basename like Obsidian's resolver. */
function appWith(rows: unknown[], notes: string[]) {
  const calls: { linkpath: string; sourcePath: string }[] = [];
  const app = {
    plugins: {
      plugins: {
        datacore: { api: { tryQuery: async () => ({ successful: true, value: rows }) } },
      },
    },
    metadataCache: {
      getFirstLinkpathDest(linkpath: string, sourcePath: string) {
        calls.push({ linkpath, sourcePath });
        const hit = notes.find((p) => p.replace(/^.*\//, "").replace(/\.md$/, "") === linkpath);
        return hit ? Object.assign(new TFile(), { path: hit }) : null;
      },
    },
  };
  return { app: app as unknown as InternalApp, calls };
}

async function query(app: InternalApp): Promise<Answer> {
  const route = buildDatacoreRoutes(app).find((r: RouteDef) => r.path === "/datacore/query");
  if (!route) throw new Error("no /datacore/query route");
  const seen: Answer = {};
  const res: BridgeRes = {
    status(code: number) {
      seen.status = code;
      return res;
    },
    json(body: unknown) {
      seen.body = body as Answer["body"];
    },
  };
  await route.handler({ body: { query: "@page" } } as BridgeReq, res);
  return seen;
}

const row = (fields: Record<string, unknown>) => ({
  $path: "Daily/2026-01-01.md",
  $name: "2026-01-01",
  $tags: [],
  $types: ["page"],
  $frontmatter: fields,
});

/** Datacore wraps each frontmatter entry as `{ key, value, raw }`; the route unwraps `value`. */
const entry = (key: string, value: unknown) => ({ key, value, raw: String(value) });

/** Datacore's Link is a class instance whose fields are getters, not own properties. */
class DcLink {
  readonly #path: string;
  readonly #display: string | null;
  constructor(path: string, display: string | null) {
    this.#path = path;
    this.#display = display;
  }
  get path() {
    return this.#path;
  }
  get type() {
    return "file" as const;
  }
  get display() {
    return this.#display;
  }
  get subpath() {
    return null;
  }
  get embed() {
    return false;
  }
  toString() {
    return `[[${this.#path}|${this.#display}]]`;
  }
}

describe("query_datacore route: frontmatter links", () => {
  it("answers a plain-object Link with the object form of the note it resolves to", async () => {
    const link = { path: "My Project", type: "file", display: "Mine", subpath: null, embed: false };
    const { app, calls } = appWith(
      [row({ project: entry("project", link) })],
      ["Projects/My Project.md"],
    );

    const out = await query(app);

    expect(out.body?.result?.items[0]?.fields.project).toEqual({
      path: "Projects/My Project.md",
      type: "file",
      display: "Mine",
      subpath: null,
      embed: false,
    });
    expect(calls).toEqual([{ linkpath: "My Project", sourcePath: "Daily/2026-01-01.md" }]);
  });

  it("reads the fields of a class-instance Link through its getters", async () => {
    const { app } = appWith(
      [row({ project: entry("project", new DcLink("My Project", "Mine")) })],
      ["Projects/My Project.md"],
    );

    const out = await query(app);

    expect(out.body?.result?.items[0]?.fields.project).toEqual({
      path: "Projects/My Project.md",
      type: "file",
      display: "Mine",
      subpath: null,
      embed: false,
    });
  });

  it("keeps the string form of a Link whose note does not resolve", async () => {
    const link = new DcLink("Missing", "Gone");
    const { app } = appWith([row({ project: entry("project", link) })], ["Projects/Other.md"]);

    const out = await query(app);

    expect(out.body?.result?.items[0]?.fields.project).toBe(String(link));
  });

  it("resolves each Link inside an array and recurses as before", async () => {
    const link = { path: "My Project", type: "file", display: null, subpath: null, embed: false };
    const { app } = appWith(
      [row({ projects: entry("projects", [link, "plain"]) })],
      ["Projects/My Project.md"],
    );

    const out = await query(app);

    expect(out.body?.result?.items[0]?.fields.projects).toEqual([
      { path: "Projects/My Project.md", type: "file", display: null, subpath: null, embed: false },
      "plain",
    ]);
  });

  it("leaves objects that are not Links on today's string path", async () => {
    const pathKeyed = { path: "C:\\Users\\x" };
    const unknownType = { path: "My Project", type: "folder" };
    const { app, calls } = appWith(
      [row({ home: entry("home", pathKeyed), kind: entry("kind", unknownType) })],
      ["Projects/My Project.md"],
    );

    const out = await query(app);

    expect(out.body?.result?.items[0]?.fields).toEqual({
      home: String(pathKeyed),
      kind: String(unknownType),
    });
    expect(calls).toEqual([]);
  });
});
