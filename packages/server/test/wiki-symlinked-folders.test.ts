// A symlinked wiki folder and a symlinked raw folder are one directory with two names, and every
// decision made on a path must hold under both. The release review's reproductions:
//  - `wiki -> pages`: read_note("wiki/log.md") with only read:notes must not return the log, because
//    enforcement resolves the symlink and so the read:provenance rule must cover the target too;
//  - `raw -> sources` with `sources/Topic.md`: a raw note under its canonical name is still raw, so it
//    is never "an existing page", never blocks a commit, and its text never reaches the wiki judge.
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { finalizeConfig } from "../src/config/load";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { MetricsRecorder } from "../src/metrics/registry";
import type { GatewayCompletionRequest, GatewayRoles } from "../src/plane/gateway";
import { buildAcls } from "../src/runtime/acl-build";
import { wireGovernance } from "../src/runtime/governance";
import { NO_EXCLUSION } from "../src/search/index-exclusion";
import { registerM1Tools } from "../src/tools/m1";
import { isGeneratedWikiPath, rawPathFilter } from "../src/tools/m7/knowledge/wiki-folder";
import { loadSendable } from "../src/tools/m7/knowledge/wiki-judge";
import { nativeVaultIo } from "../src/vault/notes-io";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";
import { makeWikiHarness, type WikiHarness } from "./wiki-test-helpers";

const link = (root: string, target: string, at: string): void => {
  const abs = join(root, at);
  mkdirSync(dirname(abs), { recursive: true });
  symlinkSync(target, abs);
};
const NOTES_ONLY = { grantedScopes: new Set(["read:notes"]) };
const WITH_PROVENANCE = { grantedScopes: new Set(["read:notes", "read:provenance"]) };

let h: WikiHarness;
const temps: string[] = [];
afterEach(() => {
  h?.v.cleanup();
  for (const t of temps.splice(0)) rmTemp(t);
});

describe.skipIf(process.platform === "win32")(
  "wiki -> pages: the log.md scope follows the symlink",
  () => {
    const LOG =
      "# Log\n\n2026-01-01T00:00:00Z | create | wiki/Ada.md | alice-the-principal | secret-model\n";
    const symlinked = (): WikiHarness =>
      (h = makeWikiHarness({
        files: {
          "pages/log.md": LOG,
          "pages/Ada.md": "# Ada\n",
          "notes/log.md": "an ordinary log\n",
        },
        wikiFolder: "wiki",
        setup: (root) => symlinkSync(join(root, "pages"), join(root, "wiki")),
      }));
    const read = (path: string, over: object) =>
      h.v.call("read_note", { vault: "test", path }, over);

    it("read_note('wiki/log.md') with only read:notes is denied (the reviewers' reproduction)", async () => {
      symlinked();
      const r = await read("wiki/log.md", NOTES_ONLY);
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain("alice-the-principal");
    });

    it("the target spelling pages/log.md is the same file and is denied the same way", async () => {
      symlinked();
      const r = await read("pages/log.md", NOTES_ONLY);
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain("alice-the-principal");
    });

    it("with read:provenance both spellings read; an unrelated log.md is untouched", async () => {
      symlinked();
      // Either spelling of a pinned folder is served through the pin, which only the native module
      // can open.
      expect((await read("wiki/log.md", WITH_PROVENANCE)).ok).toBe(nativeVaultIo);
      expect((await read("pages/log.md", WITH_PROVENANCE)).ok).toBe(nativeVaultIo);
      expect((await read("notes/log.md", NOTES_ONLY)).ok).toBe(true);
    });

    it("a wiki folder whose real place cannot be established fails closed: the ACL is refused", () => {
      const outside = makeTempDir("obtc-outside-");
      const root = makeTempDir("obtc-vault-");
      temps.push(outside, root);
      symlinkSync(outside, join(root, "wiki"));
      expect(() =>
        buildAcls({ readOnly: false, defaultScopes: [], rules: [] }, [
          { id: "v", path: root, wiki: { folder: "wiki" } },
        ]),
      ).toThrow(/wiki\.folder .* cannot be placed inside the vault/);
    });

    it("an operator rule on the same path is kept: the canonical rule adds the scope, never drops theirs", () => {
      const root = makeTempDir("obtc-vault-");
      temps.push(root);
      mkdirSync(join(root, "pages"));
      symlinkSync(join(root, "pages"), join(root, "wiki"));
      const { aclByVault } = buildAcls(
        {
          readOnly: false,
          defaultScopes: [],
          rules: [{ glob: "pages/**", scopes: ["read:pages"] }],
        },
        [{ id: "v", path: root, wiki: { folder: "wiki" } }],
      );
      expect(aclByVault.get("v")?.scopesForPath("pages/log.md").sort()).toEqual([
        "read:pages",
        "read:provenance",
      ]);
    });

    // The ACL is built once at startup. A vault whose root is missing then has no real place to
    // resolve `wiki` to, and one that appears later with `wiki -> pages` must not leave log.md open.
    it("a vault root that appears after startup with wiki -> pages still gates log.md (late recovery)", async () => {
      const parent = makeTempDir("obtc-late-");
      temps.push(parent);
      const root = join(parent, "vault");
      const cfg = finalizeConfig({
        vaults: [{ id: "late", path: root, wiki: { folder: "wiki" } }],
        cacheDir: ".otc-test-cache",
      });
      const db: Database = openMemoryDb();
      provisionCacheDb(db);
      const governance = wireGovernance({
        db,
        cacheDir: cfg.cacheDir,
        vaults: cfg.vaults,
        acl: cfg.acl,
        defaultVaultId: undefined,
        elicitTtlSeconds: cfg.elicitTtlSeconds,
        throttle: cfg.throttle,
        maxResponseBytes: cfg.governor.maxResponseBytes,
        idempotencyTtlSeconds: cfg.idempotencyTtlSeconds,
        idempotencyReclaimSeconds: cfg.idempotencyReclaimSeconds,
        toolVisibility: cfg.toolVisibility,
        metrics: new MetricsRecorder(),
        tracer: undefined,
        morgiana: { emit: () => {} },
        getAuditWriteFailureCounter: () => ({ auditWriteFailures: 0 }),
      });
      registerM1Tools(governance.registry, {
        vaultRegistry: governance.vaultRegistry,
        version: "test",
        startedAt: 0,
        embeddings: { provider: "ollama", model: "nomic-embed-text" },
      });
      // The vault appears after the ACL was frozen.
      mkdirSync(join(root, "pages"), { recursive: true });
      writeFileSync(join(root, "pages", "log.md"), LOG);
      symlinkSync(join(root, "pages"), join(root, "wiki"));
      const read = (path: string, scopes: string[]) =>
        governance.registry.dispatch(
          "read_note",
          { vault: "late", path },
          {
            caller: "late-recovery-test",
            authenticated: true,
            grantedScopes: new Set(scopes),
            vaultId: "late",
            db,
          },
        ) as Promise<{ ok: boolean }>;
      for (const path of ["wiki/log.md", "pages/log.md"]) {
        const denied = await read(path, ["read:notes"]);
        expect(denied.ok).toBe(false);
        expect(JSON.stringify(denied)).not.toContain("alice-the-principal");
        expect((await read(path, ["read:notes", "read:provenance"])).ok).toBe(nativeVaultIo);
      }
    });
  },
);

const CLIP = "# Topic\n\nSOURCE-CLIP-TEXT a saved article about Topic.\n";
const judgeRoles = (calls: GatewayCompletionRequest[]): GatewayRoles =>
  ({
    extract: async () => ({ text: "", model: "m" }),
    synthesize: async () => ({ text: "", model: "m" }),
    judge: async (req: GatewayCompletionRequest) => {
      calls.push(req);
      return { text: JSON.stringify({ verdict: "same_topic", rationale: "same" }), model: "m" };
    },
  }) as unknown as GatewayRoles;

describe.skipIf(process.platform === "win32")(
  "raw -> sources: the canonical target is raw everywhere",
  () => {
    const SCHEMA = "---\ntypes:\n  concept:\n    required: [type]\nproperties:\n  type:\n---\n";
    const symlinked = (opts: Parameters<typeof makeWikiHarness>[0] = {}): WikiHarness =>
      (h = makeWikiHarness({
        files: {
          "wiki/SCHEMA.md": SCHEMA,
          "wiki/Page.md": "# Page\n\nBody.\n",
          "sources/Topic.md": CLIP,
        },
        wikiFolder: "wiki",
        vectors: { Topic: [1, 0, 0, 0] },
        setup: (root) => link(root, join(root, "sources"), "raw"),
        ...opts,
      }));

    it("draft_wiki_page does not report `exists` from sources/Topic.md (the reviewers' reproduction)", async () => {
      symlinked();
      const d = await h.data("draft_wiki_page", { topic: "Topic", type: "concept" });
      expect(d.verdict).not.toBe("exists");
      expect(JSON.stringify(d)).not.toContain("sources/Topic.md");
    });

    it("find_existing_page names no candidate under the canonical raw target", async () => {
      symlinked();
      const d = await h.data("find_existing_page", { topic: "Topic" });
      expect(d.verdict).toBe("new");
      expect(JSON.stringify(d.candidates)).not.toContain("sources/");
    });

    it("commit_wiki_page of wiki/Topic.md is not blocked as a duplicate by the raw note", async () => {
      symlinked();
      const r = await h.v.call("commit_wiki_page", {
        vault: "test",
        topic: "Topic",
        type: "concept",
        page: {
          path: "wiki/Topic.md",
          frontmatter: { type: "concept" },
          body: "# Topic\n\nBody.\n",
        },
        patches: [],
      });
      expect(r.ok).toBe(true);
    });

    it("lint_wiki proposes nothing about sources/Topic.md", async () => {
      symlinked();
      h.seed("sources/Topic.md", [0.9, 0.3, 0, 0]);
      h.seed("wiki/Page.md", [0.9, 0.3, 0, 0]);
      const d = await h.data("lint_wiki", {});
      expect(JSON.stringify(d.proposals)).not.toContain("sources/");
    });

    it("find_existing_page(judge) never sends the raw note's text to the judge", async () => {
      const calls: GatewayCompletionRequest[] = [];
      symlinked({
        roles: judgeRoles(calls),
        wikiJudge: {},
        vectors: { "vector topic": [1, 0, 0, 0] },
        files: {
          "wiki/Page.md": "# Page\n\nBody.\n",
          "sources/Clip.md": "# Clip\n\nSOURCE-CLIP-TEXT a saved article.\n",
        },
      });
      h.seed("sources/Clip.md", [0.98, 0.1, 0, 0]);
      h.seed("wiki/Page.md", [0.9, 0.3, 0, 0]);
      await h.v.call("find_existing_page", { vault: "test", topic: "vector topic", judge: true });
      // The control: a real page is judged (so the judge ran), the raw note's text is not sent.
      expect(JSON.stringify(calls)).toContain("Body.");
      expect(JSON.stringify(calls)).not.toContain("SOURCE-CLIP-TEXT");
    });

    it("loadSendable refuses a raw note outright, whichever spelling reached it", () => {
      symlinked();
      const scope = {
        root: h.v.root,
        acl: undefined,
        grantedScopes: ["read:notes"],
        exclusion: NO_EXCLUSION,
        rawFolders: ["raw", "sources"],
      };
      for (const rel of ["sources/Topic.md", "raw/Topic.md"])
        expect(loadSendable(scope, undefined, rel)).toEqual({ refused: "raw" });
      expect("note" in loadSendable(scope, undefined, "wiki/Page.md")).toBe(true);
    });

    // The scans read every note, including the pinned raw target, which the JS path refuses.
    it.skipIf(!nativeVaultIo)(
      "find_orphans and audit_provenance leave the raw sources out, under either name",
      async () => {
        symlinked();
        const orphans = await h.data("find_orphans", {});
        const audit = await h.data("audit_provenance", {});
        // The control: a real page is still reported, so the scans ran.
        expect(JSON.stringify(orphans.orphans)).toContain("wiki/Page.md");
        expect(JSON.stringify(audit.missing)).toContain("wiki/Page.md");
        expect(JSON.stringify(orphans.orphans)).not.toContain("sources/");
        expect(JSON.stringify(audit.missing)).not.toContain("sources/");
      },
    );

    it("rawPathFilter treats every given raw folder as raw", () => {
      const isRaw = rawPathFilter(["raw", "sources"]);
      expect([isRaw("raw/a.md"), isRaw("sources/a.md"), isRaw("wiki/a.md")]).toEqual([
        true,
        true,
        false,
      ]);
      expect(rawPathFilter("raw")("raw/a.md")).toBe(true);
      expect(rawPathFilter(undefined)("raw/a.md")).toBe(false);
    });
  },
);

describe.skipIf(process.platform === "win32")(
  "wiki -> pages: the generated pages are generated under either name",
  () => {
    const symlinked = (): WikiHarness =>
      (h = makeWikiHarness({
        files: {
          "pages/log.md": "# Log\n\nthe topic of the log\n",
          "pages/index.md": "# Index\n\nthe topic of the index\n",
          "pages/Ada.md": "# Ada\n\nBody.\n",
        },
        wikiFolder: "wiki",
        vectors: { Ada: [1, 0, 0, 0] },
        setup: (root) => symlinkSync(join(root, "pages"), join(root, "wiki")),
      }));

    it("isGeneratedWikiPath knows the canonical spelling as well as the configured one", () => {
      const names = ["wiki", "pages"];
      for (const p of ["wiki/log.md", "wiki/index.md", "pages/log.md", "pages/index.md"])
        expect(isGeneratedWikiPath(p, names)).toBe(true);
      for (const p of ["pages/Ada.md", "notes/log.md", "log.md", "pages/sub/log.md"])
        expect(isGeneratedWikiPath(p, names)).toBe(false);
      // A wiki folder that is the vault root: its generated pages sit at the top.
      expect(isGeneratedWikiPath("log.md", ["wiki", ""])).toBe(true);
      expect(isGeneratedWikiPath("log.md", "wiki")).toBe(false);
      expect(isGeneratedWikiPath("pages/log.md", "wiki")).toBe(false);
    });

    it("the registry names both spellings of the wiki folder", () => {
      symlinked();
      expect(h.v.vaultRegistry.resolve("test").wikiFolders).toEqual(["wiki", "pages"]);
    });

    it("loadSendable refuses a generated page under either name, and still sends a real page", () => {
      symlinked();
      const scope = {
        root: h.v.root,
        acl: undefined,
        grantedScopes: ["read:notes", "read:provenance"],
        exclusion: NO_EXCLUSION,
        wikiFolders: h.v.vaultRegistry.resolve("test").wikiFolders,
      };
      for (const rel of ["wiki/log.md", "pages/log.md", "wiki/index.md", "pages/index.md"])
        expect(loadSendable(scope, undefined, rel)).toEqual({ refused: "generated" });
      expect("note" in loadSendable(scope, undefined, "pages/Ada.md")).toBe(true);
    });

    it.skipIf(!nativeVaultIo)(
      "find_existing_page never offers the generated log as a candidate, even to a provenance holder",
      async () => {
        symlinked();
        h.seed("pages/log.md", [1, 0, 0, 0]);
        h.seed("pages/Ada.md", [0.9, 0.3, 0, 0]);
        const d = await h.v.call(
          "find_existing_page",
          { vault: "test", topic: "Ada" },
          WITH_PROVENANCE,
        );
        expect(d.ok).toBe(true);
        // The control: the real page is a candidate, so the semantic search ran and returned hits.
        expect(JSON.stringify(d)).toContain("pages/Ada.md");
        expect(JSON.stringify(d)).not.toContain("log.md");
      },
    );
  },
);
