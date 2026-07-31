// THE-567: closes the P1.4 rule-scope gap for the six periodic-note / memory-entity tools that
// were in EXEMPT_NO_PATH (acl-extraction-coverage.test.ts) because their real vault path depends
// on server config (the periodic resolver, the memory folder), not just the parsed input.
//
// Two routes, mirrored here:
//  - create_periodic_note's template_override IS input-derivable, so it now has a pathAcl
//    extractor and is centrally enforced by runDispatch (like any other extractor-declared path).
//  - Every other touched path in these six tools is config-computed, so ctx.grantedScopes is now
//    threaded into the tool's existing handler-side enforcePathAcl call(s) instead. Before this
//    change those calls omitted grantedScopes entirely, so pathScopesSatisfied was never even
//    consulted (enforcePathAcl short-circuits to "allowed" when grantedScopes is undefined) — a
//    caller holding the tool-level scope (e.g. write:periodic) but NOT the path's rule-scope could
//    still write there. These tests fail against the pre-fix code for exactly that reason.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { getEntityById, parseObservations, relationsForEntity } from "../src/memory/entities";
import { registerM3Tools } from "../src/tools/m3";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";
import { makeM3Vault } from "./m3-helpers";
import { makeM5Vault } from "./m5-helpers";
import { rmTemp } from "./tmp";

describe("THE-567 create_periodic_note: template_override is centrally enforced (extractor route)", () => {
  function setup() {
    const root = mkdtempSync(join(tmpdir(), "obtc-567-central-"));
    const db: Database = openMemoryDb();
    provisionCacheDb(db);
    // templates/** carries a rule-scope; the daily-note target itself has no rule (unrestricted),
    // isolating the assertion to the template_override path the extractor declares.
    const acl = new FolderAcl({
      readOnly: false,
      defaultScopes: [],
      rules: [{ glob: "templates/**", scopes: ["read:templates"] }],
    });
    const vaultRegistry = new VaultRegistry([{ id: "test", path: root }]);
    const registry = new ToolRegistry({ rootResolver: () => root });
    registerM3Tools(registry, { vaultRegistry });
    const ctx = (grantedScopes: string[]): CallerContext => ({
      caller: "t",
      authenticated: true,
      grantedScopes: new Set(grantedScopes),
      vaultId: "test",
      db,
      acl,
    });
    return { root, registry, ctx };
  }

  it("denies when the caller holds the tool scope but not the template folder's rule-scope", async () => {
    const { root, registry, ctx } = setup();
    try {
      const denied = await registry.dispatch(
        "create_periodic_note",
        {
          vault: "test",
          period: "daily",
          date: "2026-06-18",
          template_override: "templates/daily.md",
        },
        ctx(["write:periodic"]), // tool-level scope only — missing read:templates
      );
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error.code).toBe("acl_denied");
    } finally {
      rmTemp(root);
    }
  });

  it("allows and uses the template once the caller also holds the rule-scope", async () => {
    const { root, registry, ctx } = setup();
    try {
      mkdirSync(join(root, "templates"), { recursive: true });
      writeFileSync(join(root, "templates", "daily.md"), "# Daily\n- [ ] task\n");
      const allowed = await registry.dispatch(
        "create_periodic_note",
        {
          vault: "test",
          period: "daily",
          date: "2026-06-18",
          template_override: "templates/daily.md",
        },
        ctx(["write:periodic", "read:templates"]),
      );
      expect(allowed.ok).toBe(true);
      if (allowed.ok)
        expect((allowed.data as { template_used: string }).template_used).toBe(
          "templates/daily.md",
        );
    } finally {
      rmTemp(root);
    }
  });
});

describe("THE-567 periodic tools: handler-side rule-scope enforcement (config-computed target path)", () => {
  // The daily-note target ("2026-06-18.md") lives at vault root; *.md at the root carries a
  // rule-scope so the (config-resolved) target path is gated independently of any input path.
  const aclCfg = { rules: [{ glob: "*.md", scopes: ["write:daily"] }] };

  it("create_periodic_note: denies with the tool scope but not the target's rule-scope, allows with it", async () => {
    const v = makeM3Vault({ acl: aclCfg });
    try {
      const denied = await v.call(
        "create_periodic_note",
        { vault: "test", period: "daily", date: "2026-06-18" },
        { grantedScopes: new Set(["write:periodic"]) },
      );
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error.code).toBe("acl_denied");
      expect(v.exists("2026-06-18.md")).toBe(false);

      const allowed = await v.call(
        "create_periodic_note",
        { vault: "test", period: "daily", date: "2026-06-18" },
        { grantedScopes: new Set(["write:periodic", "write:daily"]) },
      );
      expect(allowed.ok).toBe(true);
      expect(v.exists("2026-06-18.md")).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("find_or_create_periodic_note: denies creation with the tool scope but not the rule-scope, allows with it", async () => {
    const v = makeM3Vault({ acl: aclCfg });
    try {
      const denied = await v.call(
        "find_or_create_periodic_note",
        { vault: "test", period: "daily", date: "2026-06-18" },
        { grantedScopes: new Set(["read:periodic", "write:periodic"]) },
      );
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error.code).toBe("acl_denied");
      expect(v.exists("2026-06-18.md")).toBe(false);

      const allowed = await v.call(
        "find_or_create_periodic_note",
        { vault: "test", period: "daily", date: "2026-06-18" },
        { grantedScopes: new Set(["read:periodic", "write:periodic", "write:daily"]) },
      );
      expect(allowed.ok).toBe(true);
      if (allowed.ok) expect((allowed.data as { created: boolean }).created).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("append_to_periodic_note: denies with the tool scope but not the rule-scope, allows with it", async () => {
    const v = makeM3Vault({ acl: aclCfg });
    try {
      const denied = await v.call(
        "append_to_periodic_note",
        { vault: "test", period: "daily", date: "2026-06-18", content: "hello" },
        { grantedScopes: new Set(["write:periodic"]) },
      );
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error.code).toBe("acl_denied");
      expect(v.exists("2026-06-18.md")).toBe(false);

      const allowed = await v.call(
        "append_to_periodic_note",
        { vault: "test", period: "daily", date: "2026-06-18", content: "hello" },
        { grantedScopes: new Set(["write:periodic", "write:daily"]) },
      );
      expect(allowed.ok).toBe(true);
      expect(v.read("2026-06-18.md")).toBe("hello");
    } finally {
      v.cleanup();
    }
  });
});

describe("THE-567 memory tools: handler-side rule-scope enforcement (config-computed materialize path)", () => {
  // memory/** (the default memory folder) carries a rule-scope so the materialized entity note's
  // path is gated independently of any input path (type/name only shape the filename).
  const aclCfg = { rules: [{ glob: "memory/**", scopes: ["write:memory-notes"] }] };

  it("create_entity: denies materialization with the tool scope but not the rule-scope, allows with it", async () => {
    const v = makeM5Vault({ acl: aclCfg });
    try {
      const denied = await v.call(
        "create_entity",
        { vault: "test", type: "person", name: "Ada" },
        { grantedScopes: new Set(["write:memory"]) },
      );
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error.code).toBe("acl_denied");
      expect(v.exists("memory/person/Ada.md")).toBe(false);

      const allowed = await v.call(
        "create_entity",
        { vault: "test", type: "person", name: "Ada" },
        { grantedScopes: new Set(["write:memory", "write:memory-notes"]) },
      );
      expect(allowed.ok).toBe(true);
      expect(v.exists("memory/person/Ada.md")).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("add_observation: denies BEFORE the SQLite append lands (not just the note write), allows with the rule-scope", async () => {
    const v = makeM5Vault({ acl: aclCfg });
    try {
      const created = await v.call(
        "create_entity",
        { vault: "test", type: "person", name: "Ada" },
        { grantedScopes: new Set(["*"]) },
      );
      expect(created.ok).toBe(true);
      const entityId = created.ok ? (created.data as { entity_id: string }).entity_id : "";

      // Distinct payload for the denied call: if the DB write happened before the ACL check
      // (the pre-fix bug), this string would still land in memory_entities.observations even
      // though the tool call reports acl_denied.
      const denied = await v.call(
        "add_observation",
        { vault: "test", entity_id: entityId, observation: "SHOULD_NOT_LAND" },
        { grantedScopes: new Set(["write:memory"]) },
      );
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error.code).toBe("acl_denied");
      // Source-of-truth assertion, not just the note file: the observation must be ABSENT from
      // SQLite. This is the crux of the THE-567 review fix — a note-write failure must not leave
      // an already-committed graph mutation behind.
      const afterDenial = getEntityById(v.db, entityId);
      expect(parseObservations(afterDenial?.observations ?? "")).not.toContain("SHOULD_NOT_LAND");

      const allowed = await v.call(
        "add_observation",
        { vault: "test", entity_id: entityId, observation: "mathematician" },
        { grantedScopes: new Set(["write:memory", "write:memory-notes"]) },
      );
      expect(allowed.ok).toBe(true);
      const afterAllow = getEntityById(v.db, entityId);
      expect(parseObservations(afterAllow?.observations ?? "")).toContain("mathematician");
      expect(parseObservations(afterAllow?.observations ?? "")).not.toContain("SHOULD_NOT_LAND");
      expect(v.read("memory/person/Ada.md")).toContain("mathematician");
    } finally {
      v.cleanup();
    }
  });

  it("link_entities: denies BEFORE the relation edge lands (not just the note write), allows with the rule-scope", async () => {
    const v = makeM5Vault({ acl: aclCfg });
    try {
      const src = await v.call(
        "create_entity",
        { vault: "test", type: "person", name: "Ada" },
        { grantedScopes: new Set(["*"]) },
      );
      const tgt = await v.call(
        "create_entity",
        { vault: "test", type: "person", name: "Charles" },
        { grantedScopes: new Set(["*"]) },
      );
      expect(src.ok && tgt.ok).toBe(true);
      const sourceId = src.ok ? (src.data as { entity_id: string }).entity_id : "";
      const targetId = tgt.ok ? (tgt.data as { entity_id: string }).entity_id : "";

      // Distinct relation_type for the denied call, so a leaked edge is unambiguous.
      const denied = await v.call(
        "link_entities",
        {
          vault: "test",
          source_id: sourceId,
          target_id: targetId,
          relation_type: "SHOULD_NOT_LAND",
        },
        { grantedScopes: new Set(["write:memory"]) },
      );
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error.code).toBe("acl_denied");
      // Source-of-truth assertion: the edge must be ABSENT from memory_relations, not just
      // missing from the note's rendered [[links]].
      expect(
        relationsForEntity(v.db, sourceId).some((r) => r.relation_type === "SHOULD_NOT_LAND"),
      ).toBe(false);

      const allowed = await v.call(
        "link_entities",
        { vault: "test", source_id: sourceId, target_id: targetId, relation_type: "knows" },
        { grantedScopes: new Set(["write:memory", "write:memory-notes"]) },
      );
      expect(allowed.ok).toBe(true);
      expect(relationsForEntity(v.db, sourceId).some((r) => r.relation_type === "knows")).toBe(
        true,
      );
      expect(
        relationsForEntity(v.db, sourceId).some((r) => r.relation_type === "SHOULD_NOT_LAND"),
      ).toBe(false);
      expect(v.read("memory/person/Ada.md")).toContain("[[Charles]]");
    } finally {
      v.cleanup();
    }
  });
});
