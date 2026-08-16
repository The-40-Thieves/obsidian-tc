// THE-513 Part 2 guarantee test — the security-relevant half. mcp/registry.ts reads the caller's
// target vault at FOUR sites (vault-binding guard THE-267, per-vault ACL swap THE-295, the reverse
// vault-kind gate THE-569, and central pathAcl enforcement THE-414) by casting the parsed input to
// `{ vault?: unknown }`. Before this gate, a capability naming that argument anything other than
// "vault" silently escaped all four — they simply saw `undefined` and skipped, not denied. (THE-589
// hit exactly this shape from the other side: generate_uri's `vault_name` collided with the
// hardcoded guard and had to be renamed away from it, because there was no way to tell the dispatch
// pipeline "this field isn't the vault arg" short of not calling it `vault`.)
//
// `def.vaultArg` closes the gap: the four sites now read `def.vaultArg ?? "vault"` (see
// vaultArgOf in registry.ts) instead of hardcoding the literal. This test is the static coverage
// half — every MUTATING tool whose schema has a vault-shaped field must declare it, so a
// capability that adds one and forgets is a test failure, not a silent bypass.
// vault-arg-dispatch.test.ts is the behavioral half: it proves the four sites actually READ the
// declared name, with synthetic tools whose vault field isn't called "vault".
//
// Mutating derivation mirrors acl-extraction-coverage.test.ts exactly (destructive === true, or
// any required scope in the write|delete|bulk|execute families) — this is deliberately not a
// second definition of "mutating".
import { isMutatingScope, VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { buildFullRegistry } from "../scripts/docgen/build-registry";
import { fieldIs, topLevelShape } from "./schema-introspect";

/** The top-level field (if any) whose schema is reference-identical to the shared `VaultId`
 *  primitive — i.e. actually vault-shaped, not just named "vault" or "vault_name" (THE-589's
 *  generate_uri has a `vault_name` that is a plain string DISPLAY name, not a VaultId, and must
 *  NOT be flagged here). */
function vaultShapedField(inputSchema: unknown): string | undefined {
  const shape = topLevelShape(inputSchema);
  if (!shape) return undefined;
  return Object.keys(shape).find((key) => fieldIs(shape, key, VaultId));
}

describe("THE-513 Part 2: vaultArg declaration coverage", () => {
  const registered = buildFullRegistry().list();
  const mutating = registered.filter(
    (d) => d.destructive === true || d.requiredScopes.some(isMutatingScope),
  );

  it("checked a non-empty, non-trivially-small mutating set, so coverage is not vacuous", () => {
    expect(registered.length).toBeGreaterThan(100);
    expect(mutating.length).toBeGreaterThan(10);
  });

  it("every mutating tool with a vault-shaped input field declares vaultArg naming it", () => {
    const offenders = mutating
      .filter((d) => {
        const field = vaultShapedField(d.inputSchema);
        return field !== undefined && d.vaultArg !== field;
      })
      .map((d) => `${d.name} (field: ${vaultShapedField(d.inputSchema)}, declared: ${d.vaultArg})`)
      .sort();
    expect(
      offenders,
      `mutating tool(s) with an undeclared or mis-declared vaultArg: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("no tool declares a vaultArg that doesn't name an actual field on its own schema", () => {
    // Catches the OTHER wrong declaration: a typo, or a name pointing at a field that isn't
    // there at all — a declaration nothing validates is exactly the "just a comment" gap THE-513
    // exists to close.
    const badDeclarations = registered
      .filter((d) => d.vaultArg !== undefined && !topLevelShape(d.inputSchema)?.[d.vaultArg])
      .map((d) => `${d.name} (vaultArg: ${d.vaultArg})`)
      .sort();
    expect(
      badDeclarations,
      `tool(s) whose declared vaultArg names no field on their own schema: ${badDeclarations.join(", ")}`,
    ).toEqual([]);
  });

  it("re-derives the known mutating+vault-shaped surface (51 of 54 mutating tools, THE-513 Part 2)", () => {
    // Three mutating tools have NO vault field at all — they operate on the experiential SQLite
    // store, not a caller-named vault — named explicitly here rather than just asserting a count,
    // same reasoning as REGISTERED_TOOL_COUNT.
    //
    // THE-726: work_result is the third, and it takes no vault for a stronger reason than the
    // other two. Its target is the caller's own open session, resolved from the server-observed
    // principal via activeSessionFor — never from caller input. Accepting a `vault` would invite
    // exactly the caller-named-target shape THE-838 had to close on end_session, so its absence is
    // a security property rather than an omission.
    const withoutVaultField = mutating
      .filter((d) => vaultShapedField(d.inputSchema) === undefined)
      .map((d) => d.name)
      .sort();
    expect(withoutVaultField).toEqual(["record_retrieval_feedback", "work_forget", "work_result"]);
  });
});
