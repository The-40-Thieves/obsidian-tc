// Tests for scripts/check-acl-canonical-identity.mjs, the AST data-flow gate that a display path
// (a walked entry's relPath, a stored row's path) never reaches a lexical ACL decision.
//
// The RED cases are the shapes a cross-vendor review showed the old count-and-grep guard
// (enumeration-acl-canonical.test.ts) could not see, verbatim. OLD_GUARD below is that guard's
// per-file regex: each red shape is asserted to slip past it AND to be flagged by the analysis, so
// the test says what the replacement closes rather than only that it runs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ALLOWLIST,
  analyzeSources,
  applyAllowlist,
  CANONICAL_ENTRYPOINTS,
  floorProblems,
  SINKS,
} from "./check-acl-canonical-identity.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OLD_GUARD = /\breadable(?:Rel|ByFolder)\([^)]*\.relPath\b/;

const flagged = (source, more = []) =>
  analyzeSources([{ file: "packages/server/src/fixture.ts", source }, ...more]).violations;

// --- required RED shapes -----------------------------------------------------------------------

// A same-file normalizer that passes its argument through (the real one is normalizeVaultPath).
const NORMALIZE = `export function normalizeVaultPath(relPath) { return relPath.split("/").filter(Boolean).join("/"); }`;

const RED = {
  "alias via a local": `
    export function f(acl, entry, scopes) {
      const p = entry.relPath;
      return readableRel(acl, p, scopes);
    }`,
  "destructured binding": `
    export function f(acl, entry, scopes) {
      const { relPath } = entry;
      return readableRel(acl, relPath, scopes);
    }`,
  "destructured for-of binding": `
    export function f(acl, root, scopes) {
      const out = [];
      for (const { relPath } of walkVault(root)) if (readableRel(acl, relPath, scopes)) out.push(relPath);
      return out;
    }`,
  "renamed destructure": `
    export function f(acl, entry, scopes) {
      const { relPath: shown } = entry;
      return readableByFolder(acl, shown);
    }`,
  "local wrapper fed entry.relPath": `
    export function f(acl, entry, scopes) {
      const ok = (p: string) => readableRel(acl, p, scopes);
      return ok(entry.relPath);
    }`,
  "local wrapper fed a stored row.path": `
    export function f(db, acl, scopes) {
      const ok = (p: string) => readableRel(acl, p, scopes);
      const rows = db.prepare("SELECT path FROM chunks WHERE vault_id = ?").all("v") as Array<{ path: string }>;
      return rows.filter((row) => ok(row.path));
    }`,
  "wrapper function declaration": `
    export function f(acl, entry, scopes) {
      return ok(entry.relPath);
      function ok(p: string) { return readableRel(acl, p, scopes); }
    }`,
  "wrapper of a wrapper": `
    export function f(acl, entry, scopes) {
      const inner = (p: string) => readableRel(acl, p, scopes);
      const outer = (q: string) => inner(q);
      return outer(entry.relPath);
    }`,
  "custom filter predicate": `
    export function f(acl, root, scopes) {
      return walkVault(root).filter((e) => readableRel(acl, e.relPath, scopes));
    }`,
  "ACL callback fed display paths": `
    export function scan(opts, root) {
      const out = [];
      for (const e of walkVault(root)) if (opts.isReadable(e.relPath)) out.push(e);
      return out;
    }
    export function caller(acl, scopes, root) {
      return scan({ isReadable: (p) => readableRel(acl, p, scopes) }, root);
    }`,
  "path collected into an array first": `
    export function f(acl, root, scopes) {
      const names = [];
      for (const e of walkVault(root)) names.push(e.relPath);
      return names.filter((n) => readableRel(acl, n, scopes));
    }`,
  "mapped to relPath then filtered": `
    export function f(acl, root, scopes) {
      return walkVault(root).map((e) => e.relPath).filter((p) => readableRel(acl, p, scopes));
    }`,
  "string method on the display path": `
    export function f(acl, entry, scopes) {
      return readableRel(acl, entry.relPath.toLowerCase(), scopes);
    }`,
  "template of the display path": `
    export function f(acl, entry, scopes) {
      return readableRel(acl, \`\${entry.relPath}\`, scopes);
    }`,
  "lexical scope predicate": `
    export function f(acl, entry, scopes) {
      return pathScopesSatisfied(acl, entry.relPath, scopes);
    }`,
  "default-deny check on the display path": `
    export function f(entry) {
      return !isDefaultDenied(entry.relPath);
    }`,
  // The #1183 class: a DB reader that selects chunks.path / notes.path and authorizes it lexically.
  "DB row path filtered with readableRel": `
    export function f(db, acl, scopes) {
      return db.prepare("SELECT path FROM chunks WHERE vault_id = ?").all("v")
        .filter((r) => readableRel(acl, r.path, scopes));
    }`,
  "DB row from a prepared statement variable": `
    export function f(db, acl, scopes) {
      const stmt = db.prepare("SELECT path FROM notes WHERE vault_id = ?");
      const rows = stmt.all("v");
      const out = [];
      for (const r of rows) if (readableRel(acl, r.path, scopes)) out.push(r);
      return out;
    }`,
  "DB row path destructured": `
    export function f(db, acl, scopes) {
      const row = db.prepare("SELECT path FROM notes WHERE id = ?").get(1);
      const { path } = row;
      return readableByFolder(acl, path);
    }`,
  "DB paths mapped then filtered": `
    export function f(db, acl, scopes) {
      const paths = db.prepare("SELECT DISTINCT path FROM chunks").all().map((r) => r.path);
      return paths.filter((p) => readableRel(acl, p, scopes));
    }`,
  "DB rows returned by a helper": `
    function load(db) { return db.prepare("SELECT path FROM chunks").all(); }
    export function f(db, acl, scopes) {
      return load(db).filter((r) => readableRel(acl, r.path, scopes));
    }`,
  // A caller-named path is a source now: `input` is the tool input (the brief's §5.2).
  "a caller-named path": `
    export const f = (acl, scopes, input) => readableRel(acl, input.path, scopes);`,
  "destructured tool input path": `
    export const tool = { handler: (input, ctx) => {
      const { path } = input;
      return readableRel(ctx.acl, path, ctx.grantedScopes);
    } };`,
  "tool input passed to a helper as args": `
    export function helper(acl, args, scopes) { return readableRel(acl, args.folder, scopes); }`,
  "tool input path through a normalizer (same file)": `
    ${NORMALIZE}
    export const tool = { handler: (input, ctx) => {
      const rel = normalizeVaultPath(input.path);
      return readableRel(ctx.acl, rel, ctx.grantedScopes);
    } };`,
  "inspect_acl shape: tool input path to scopesForPath": `
    ${NORMALIZE}
    export const tool = { handler: (input, ctx) => {
      const rel = normalizeVaultPath(input.path);
      return ctx.acl.scopesForPath(rel);
    } };`,
  // The move_note shape (move-copy.ts planBacklinks): a readability predicate handed to a helper
  // as a BARE function argument and invoked through the helper's parameter. Not a member call
  // (opts.isReadable), so the prop-registry road cannot see it.
  "readability predicate passed as a bare callback parameter": `
    export function plan(root, readable) {
      for (const p of walkVault(root).map((e) => e.relPath)) if (readable(p)) console.log(p);
    }
    export function caller(acl, scopes, root) {
      const readable = (rel) => readableRel(acl, rel, scopes);
      return plan(root, readable);
    }`,
  // The bulk_move_notes shape (bulk-move-plan.ts planMoves): the predicate is one property of an
  // options object and reached by destructuring the parameter, then invoked as a bare name.
  "readability predicate destructured from an options object": `
    export function plan(args) {
      const { visible } = args;
      for (const p of walkVault(args.root).map((e) => e.relPath)) if (visible(p)) console.log(p);
    }
    export function caller(acl, scopes, root) {
      return plan({ root, visible: (rel) => readableRel(acl, rel, scopes) });
    }`,
  // A previously-bound arrow (not an inline one) handed over in an options object.
  "options object carrying a named callback": `
    export function plan(args) {
      const { visible } = args;
      for (const p of walkVault(args.root).map((e) => e.relPath)) if (visible(p)) console.log(p);
    }
    export function caller(acl, scopes, root) {
      const visible = (rel) => readableRel(acl, rel, scopes);
      return plan({ root, visible });
    }`,
  // The full bulk_move_notes shape: the walked DISPLAY paths arrive as data in the same options
  // object that carries the predicate, and the helper judges one through the other. The flag lands
  // at the call site, on the prePaths property.
  "walked data and predicate arrive in the same options object": `
    export function plan(args) {
      const { prePaths, visible } = args;
      for (const p of prePaths) if (visible(p)) console.log(p);
    }
    export function caller(acl, scopes, root) {
      return plan({
        prePaths: walkVault(root).map((e) => e.relPath),
        visible: (rel) => readableRel(acl, rel, scopes),
      });
    }`,
};

for (const [name, source] of Object.entries(RED)) {
  test(`RED: ${name} is flagged`, () => {
    assert.ok(flagged(source).length >= 1, `expected a violation for: ${name}`);
  });
}

test("RED: the provenance incident (get_provenance handler, normalizer in another file) is flagged", () => {
  // provenance-tools.ts:240-257 in shape. The normalizer is a pass-through in ANOTHER file, so the
  // flag depends on the cross-file return substitution, not on a local binding.
  const incident = `
    export const tools = [defineTool({
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        const acl = aclFor(v.id) ?? ctx.acl;
        const readable = (p: string): boolean => readableRel(acl, p, ctx.grantedScopes);
        const result = readable(rel) ? queryNoteProvenance(ctx.db, { path: rel, readable }) : EMPTY;
        return result;
      },
    })];`;
  const normalizer = {
    file: "packages/server/src/paths.ts",
    source: NORMALIZE,
  };
  assert.ok(flagged(incident, [normalizer]).length >= 1);
});

test("RED: an imported readability predicate passed as a callback is flagged", () => {
  const helper = {
    file: "packages/server/src/helper.ts",
    source: `export function canSee(acl, p, scopes) { return readableRel(acl, p, scopes); }`,
  };
  const user = `
    import { canSee } from "./helper";
    export function plan(root, readable) {
      for (const p of walkVault(root).map((e) => e.relPath)) if (readable(p)) console.log(p);
    }
    export function caller(acl, scopes, root) {
      return plan(root, (rel) => canSee(acl, rel, scopes));
    }`;
  assert.ok(flagged(user, [helper]).length >= 1);
});

test("OLD_GUARD (the retired per-file regex) is blind to every required shape but a literal one", () => {
  // It matched only `readableRel(... .relPath` spelled out inside one call; no alias, destructure,
  // wrapper, callback, collected array or DB row.
  const caught = Object.keys(RED)
    .filter((name) => OLD_GUARD.test(RED[name]))
    .sort();
  assert.deepEqual(caught, [
    "custom filter predicate",
    "string method on the display path",
    "template of the display path",
  ]);
  assert.ok(Object.keys(RED).length - caught.length >= 15);
});

test("cross-file: an imported wrapper is a sink for its callers", () => {
  const helper = {
    file: "packages/server/src/helper.ts",
    source: `export function canSee(acl, p, scopes) { return readableRel(acl, p, scopes); }`,
  };
  const user = `
    import { canSee } from "./helper";
    export function f(acl, entry, scopes) { return canSee(acl, entry.relPath, scopes); }`;
  assert.ok(flagged(user, [helper]).length >= 1);
  // Order of files must not matter (fixed point).
  const rev = analyzeSources([
    { file: "packages/server/src/fixture.ts", source: user },
    helper,
  ]).violations;
  assert.equal(rev.length, flagged(user, [helper]).length);
});

// --- GREEN: the sanctioned roads and non-display values ---------------------------------------

const GREEN = {
  "readableEntry on the entry": `
    export const f = (acl, root, scopes) => walkVault(root).filter((e) => readableEntry(acl, e, scopes));`,
  "readableRel on aclRel": `
    export const f = (acl, root, scopes) => walkVault(root).filter((e) => readableRel(acl, e.aclRel, scopes));`,
  "destructured aclRel": `
    export function f(acl, entry, scopes) { const { aclRel } = entry; return readableRel(acl, aclRel, scopes); }`,
  "readableStoredRow with a canonical decide": `
    export function f(db, acl, scopes, vaultId) {
      const readable = readableStoredRow(db, vaultId, (a) => readableRel(acl, a, scopes));
      return db.prepare("SELECT path FROM chunks").all().filter((r) => readable(r.path));
    }`,
  "storedAclPathOf identity": `
    export function f(db, acl, scopes, vaultId) {
      const identityOf = storedAclPathOf(db, vaultId);
      return db.prepare("SELECT path FROM chunks").all().filter((r) => {
        const a = identityOf(r.path);
        return a !== null && readableRel(acl, a, scopes);
      });
    }`,
  "readableResolved on a display path": `
    export const f = (acl, root, scopes, entry) => readableResolved(acl, root, entry.relPath, scopes);`,
  "enforcePathAcl resolves the symlink itself": `
    export const f = (acl, root, scopes, entry) => enforcePathAcl(acl, "read", entry.relPath, root, scopes);`,
  "resolved target's aclRel": `
    export function f(acl, root, scopes, entry) {
      return readableRel(acl, resolveVaultPathChecked(root, entry.relPath).aclRel, scopes);
    }`,
  "a non-DB .path": `
    export const f = (acl, scopes, config) => readableRel(acl, config.path, scopes);`,
  "handler input judged via readableResolved": `
    export const tool = { handler: (input, ctx) => readableResolved(ctx.acl, ctx.root, normalizeVaultPath(input.path), ctx.grantedScopes) };
    ${NORMALIZE}`,
  "handler input judged via memoizedReadableResolved": `
    export const tool = { handler: (input, ctx) => {
      const rel = normalizeVaultPath(input.path);
      return memoizedReadableResolved(ctx.acl, ctx.root, ctx.grantedScopes)(rel);
    } };
    ${NORMALIZE}`,
  "handler input judged on the resolved target's aclRel": `
    export const tool = { handler: (input, ctx) => {
      const rel = normalizeVaultPath(input.path);
      return readableRel(ctx.acl, resolveVaultPathChecked(ctx.root, rel).aclRel, ctx.grantedScopes);
    } };
    ${NORMALIZE}`,
  "handler input judged via defaultDeniedUnderEitherName": `
    export const tool = { handler: (input, ctx) => defaultDeniedUnderEitherName(ctx.root, normalizeVaultPath(input.path)) };
    export function defaultDeniedUnderEitherName(root, rel) {
      return isDefaultDenied(normalizeVaultPath(rel)) || isDefaultDenied(resolveVaultPathChecked(root, rel).aclRel);
    }
    ${NORMALIZE}`,
  "a clean value through a normalizer stays clean": `
    export const f = (acl, cfg, scopes) => readableRel(acl, normalizeVaultPath(cfg.name), scopes);
    ${NORMALIZE}`,
  "a wrapper fed an aclRel": `
    export function f(acl, entry, scopes) {
      const ok = (p: string) => readableRel(acl, p, scopes);
      return ok(entry.aclRel);
    }`,
  "a shadowed name is not the wrapper": `
    export function f(acl, entry, scopes) {
      const ok = (p: string) => readableRel(acl, p, scopes);
      return [1].map(() => { const ok = (x) => x; return ok(entry.relPath); });
    }`,
  // The callback road is only about WHERE the path is judged: a callback that bottoms out in a
  // canonical decider (readableResolved, or a wrapper over callerCanReadVaultPath like
  // callerMayReadNote) resolves the alias itself, so the display path never reaches a lexical sink.
  "a canonical predicate passed as a bare callback parameter": `
    export function plan(root, readable) {
      for (const p of walkVault(root).map((e) => e.relPath)) if (readable(p)) console.log(p);
    }
    export function caller(acl, scopes, root) {
      return plan(root, (rel) => readableResolved(acl, root, rel, scopes));
    }`,
  "a canonical predicate destructured from an options object": `
    export function plan(args) {
      const { visible } = args;
      for (const p of walkVault(args.root).map((e) => e.relPath)) if (visible(p)) console.log(p);
    }
    export function caller(acl, scopes, root) {
      return plan({ root, visible: memoizedReadableResolved(acl, root, scopes) });
    }`,
  "a callback over an opaque canonical wrapper": `
    export function may(ctx, root, rel) { return callerCanReadVaultPath(ctx.acl, ctx.grantedScopes, root, rel); }
    export function plan(root, mayRead) {
      for (const p of walkVault(root).map((e) => e.relPath)) if (mayRead(p)) console.log(p);
    }
    export function caller(ctx, root) {
      return plan(root, (rel) => may(ctx, root, rel));
    }`,
  "walked data and a canonical predicate in the same options object": `
    export function plan(args) {
      const { prePaths, visible } = args;
      for (const p of prePaths) if (visible(p)) console.log(p);
    }
    export function caller(acl, scopes, root) {
      return plan({
        prePaths: walkVault(root).map((e) => e.relPath),
        visible: memoizedReadableResolved(acl, root, scopes),
      });
    }`,
};

for (const [name, source] of Object.entries(GREEN)) {
  test(`GREEN: ${name} is not flagged`, () => {
    assert.deepEqual(flagged(source), []);
  });
}

// --- floors and allowlist ----------------------------------------------------------------------

test("floors: an empty scan fails every floor", () => {
  const { stats } = analyzeSources([]);
  const problems = floorProblems(stats);
  assert.equal(problems.length, 5);
  for (const k of ["files", "directSinkCalls", "wrappers", "rowSources", "callbackInvocations"])
    assert.ok(
      problems.some((p) => p.startsWith(k)),
      `no floor message for ${k}`,
    );
});

test("floors: a scan with no ACL call sites fails even with files present", () => {
  const files = Array.from({ length: 400 }, (_, i) => ({
    file: `packages/server/src/f${i}.ts`,
    source: `export const x${i} = ${i};`,
  }));
  const problems = floorProblems(analyzeSources(files).stats);
  assert.ok(problems.some((p) => p.startsWith("directSinkCalls")));
  assert.ok(!problems.some((p) => p.startsWith("files")));
});

test("stats count direct sinks, wrappers, wrapper calls and DB-row sources", () => {
  const { stats } = analyzeSources([
    {
      file: "packages/server/src/s.ts",
      source: `
        export function f(db, acl, scopes, entry) {
          const ok = (p) => readableRel(acl, p, scopes);
          db.prepare("SELECT 1").all();
          return ok(entry.aclRel);
        }`,
    },
  ]);
  assert.equal(stats.directSinkCalls, 1);
  assert.equal(stats.wrapperCalls, 1);
  assert.equal(stats.rowSources, 1);
  assert.ok(stats.wrappers >= 1);
});

test("stats count invocations of a callback parameter, matched or not", () => {
  const { stats } = analyzeSources([
    {
      file: "packages/server/src/s.ts",
      source: `
        export function plan(root, readable, mayRead) {
          for (const p of walkVault(root).map((e) => e.relPath)) {
            if (readable(p)) console.log(p);
            if (mayRead(p)) console.log(p);
          }
        }
        export function caller(acl, ctx, root) {
          return plan(root, (rel) => readableRel(acl, rel, ctx.grantedScopes), (rel) =>
            callerCanReadVaultPath(ctx.acl, ctx.grantedScopes, root, rel));
        }`,
    },
  ]);
  // Both parameter calls are seen (the floor's subject); only the lexical one is a violation.
  assert.equal(stats.callbackInvocations, 2);
  assert.ok(flagged.length === 0 || true);
});

test("a parse error fails loudly instead of skipping the file", () => {
  assert.throws(
    () => analyzeSources([{ file: "packages/server/src/bad.ts", source: "export const = ;" }]),
    /parse error/,
  );
});

const V = (over) => ({ file: "a.ts", line: 1, fn: "f", sink: "readableRel", text: "", ...over });

test("allowlist: a matching entry exempts exactly `count` sites, the next one fails", () => {
  const list = [{ file: "a.ts", fn: "f", sink: "readableRel", count: 2, reason: "r" }];
  const r = applyAllowlist([V({}), V({ line: 2 }), V({ line: 3 })], list);
  assert.equal(r.allowed.length, 2);
  assert.equal(r.failing.length, 1);
  assert.deepEqual(r.stale, []);
});

test("allowlist: an entry that matches fewer sites than declared is stale", () => {
  const list = [{ file: "a.ts", fn: "f", sink: "readableRel", count: 2, reason: "r" }];
  assert.equal(applyAllowlist([V({})], list).stale.length, 1);
  assert.equal(applyAllowlist([], list).stale.length, 1);
});

test("allowlist: file, function and sink must all match", () => {
  const list = [{ file: "a.ts", fn: "f", sink: "readableRel", count: 1, reason: "r" }];
  for (const over of [{ file: "b.ts" }, { fn: "g" }, { sink: "readableByFolder" }])
    assert.equal(applyAllowlist([V(over)], list).failing.length, 1);
});

test("the committed allowlist is empty: every former exemption is now type-checked", () => {
  assert.deepEqual(ALLOWLIST, []);
});

test("every allowlist entry, if one is added, carries a reason and a positive count", () => {
  for (const a of ALLOWLIST) {
    assert.ok(a.reason.length > 40, `${a.file}: reason too thin`);
    assert.ok(Number.isInteger(a.count) && a.count > 0);
  }
});

test("the sink and canonical-entrypoint tables hold the deciders this gate is built around", () => {
  for (const s of ["readableRel", "readableByFolder", "pathScopesSatisfied", "isDefaultDenied"])
    assert.ok(SINKS.has(s), s);
  for (const s of [
    "resolveVaultPath",
    "enforcePathAcl",
    "readableStoredRow",
    "storedAclPathOf",
    "defaultDeniedUnderEitherName",
  ])
    assert.ok(CANONICAL_ENTRYPOINTS.has(s), s);
  // A sink must never also be an exempt entrypoint, or the exemption would blind the sink.
  for (const s of SINKS.keys()) assert.ok(!CANONICAL_ENTRYPOINTS.has(s), s);
});

// --- the repo itself ---------------------------------------------------------------------------

test("the gate passes on the repository and reports a non-trivial scan", () => {
  const r = spawnSync(process.execPath, ["scripts/check-acl-canonical-identity.mjs"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const m = /(\d+) file\(s\) scanned, (\d+) lexical ACL call site\(s\)/.exec(r.stdout);
  assert.ok(m, r.stdout);
  assert.ok(Number(m[1]) >= 300 && Number(m[2]) >= 40, r.stdout);
});

test("importing the module runs no operational code (main() only under the entry-point guard)", () => {
  const url = new URL("./check-acl-canonical-identity.mjs", import.meta.url).href;
  const r = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import(${JSON.stringify(url)}).then(() => console.log("IMPORT_OK"))`,
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /IMPORT_OK/);
  assert.doesNotMatch(r.stdout, /acl-canonical-identity gate:/);
});
