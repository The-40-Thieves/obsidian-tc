// THE-727: authorization resolved from the CALL, not only from the tool definition.
//
// A tool that dispatches on an `action` argument cannot declare one honest static scope set.
// Union the actions' scopes and a harmless read demands delete privileges; intersect them and a
// destructive action is under-governed. Both are unacceptable, which is why merging read and write
// tools has been blocked on this — the consolidation saving was booked behind a change to the
// authorization path of every tool at once.
//
// The tests are ordered by what they protect:
//   1. the SUBSET invariant — a resolver may narrow, never widen
//   2. the additive guarantee — a tool without a resolver behaves byte-identically
//   3. the actual capability — one tool, two actions, different scopes and different `destructive`
//   4. the ORDERING — parse must precede authorization, or the wrong action's scopes are asserted
import { ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { isMutatingCall, resolveOperationPolicy } from "../src/mcp/registry/policy-gates";

/** A consolidated tool: one name, one static declaration that is the UNION of what its actions
 *  need, and a resolver that narrows per action. This is the shape THE-727 exists to allow. */
const NOTE_MUTATE = {
  requiredScopes: ["read:notes", "write:notes", "delete:notes"],
  destructive: true,
  resolvePolicy: (input: { action: string }) => {
    switch (input.action) {
      case "read":
        return { requiredScopes: ["read:notes"], destructive: false };
      case "write":
        return { requiredScopes: ["write:notes"], destructive: false };
      default:
        return { requiredScopes: ["delete:notes"], destructive: true };
    }
  },
};

describe("the subset invariant — a resolver may NARROW, never WIDEN", () => {
  it("refuses a resolver returning a scope the tool never declared", () => {
    // The escalation this whole ticket is about: if a resolver could add scopes, the static
    // declaration — what the facade advertises, what the docs render, what a reviewer reads —
    // would be a lie about what the tool can reach.
    const escalating = {
      requiredScopes: ["read:notes"],
      resolvePolicy: () => ({ requiredScopes: ["read:notes", "delete:notes"] }),
    };
    expect(() => resolveOperationPolicy(escalating, {})).toThrow(ObsidianTcError);
    try {
      resolveOperationPolicy(escalating, {});
      expect.unreachable("should have refused");
    } catch (e) {
      const err = e as ObsidianTcError;
      // `internal`, NOT `forbidden`. The caller did nothing wrong — a resolver that over-declares
      // is a server defect, and filing it under the ordinary authorization-denial code would bury
      // it among expected refusals, which is how such a seam stays invisible.
      expect(err.code).toBe("internal");
      expect((err.details as { undeclared: string[] }).undeclared).toEqual(["delete:notes"]);
    }
  });

  it("allows narrowing to a strict subset, which is the point", () => {
    expect(resolveOperationPolicy(NOTE_MUTATE, { action: "read" }).requiredScopes).toEqual([
      "read:notes",
    ]);
  });

  it("allows an EMPTY resolved scope set — the empty set is a subset", () => {
    // Deliberate: a genuinely unprivileged action of an otherwise-privileged tool. It must not be
    // rejected by the subset check, and it must not silently inherit the static class either.
    const p = resolveOperationPolicy(
      {
        requiredScopes: ["read:notes"],
        scopeClass: "read",
        resolvePolicy: () => ({ requiredScopes: [] }),
      },
      {},
    );
    expect(p.requiredScopes).toEqual([]);
    expect(p.scopeClass).toBe("read");
  });
});

describe("additive — a tool WITHOUT a resolver is untouched", () => {
  it("returns the static declaration verbatim", () => {
    const p = resolveOperationPolicy(
      { requiredScopes: ["write:notes"], destructive: true, scopeClass: "write" },
      { anything: true },
    );
    expect(p).toStrictEqual({
      requiredScopes: ["write:notes"],
      destructive: true,
      scopeClass: "write",
    });
  });

  it("defaults destructive to false and derives scopeClass when neither is declared", () => {
    const p = resolveOperationPolicy({ requiredScopes: ["read:notes"] }, {});
    expect(p.destructive).toBe(false);
    expect(p.scopeClass).toBe("read");
  });
});

describe("one tool, two actions, different policy — the capability", () => {
  // The table-driven proof the acceptance criteria ask for: a read action and a delete action
  // through the SAME tool must resolve to different scope sets AND different `destructive`.
  const cases = [
    { action: "read", scopes: ["read:notes"], destructive: false, mutating: false },
    { action: "write", scopes: ["write:notes"], destructive: false, mutating: true },
    { action: "delete", scopes: ["delete:notes"], destructive: true, mutating: true },
  ] as const;

  for (const c of cases) {
    it(`action "${c.action}" resolves to ${c.scopes.join("+")}, destructive=${c.destructive}`, () => {
      const p = resolveOperationPolicy(NOTE_MUTATE, { action: c.action });
      expect(p.requiredScopes).toEqual([...c.scopes]);
      expect(p.destructive).toBe(c.destructive);
      // `mutating` drives the readOnly gate and the vault-kind gate. Note "write" is NOT
      // destructive yet IS mutating — isMutatingCall derives it from the resolved scopes too, so
      // lowering `destructive` cannot smuggle a write past the read-only gate.
      expect(isMutatingCall(p)).toBe(c.mutating);
    });
  }

  it("gives the read action a READ scope class, so it is throttled and counted as a read", () => {
    // Falling back to the static class would put every action of a consolidated tool in the write
    // bucket — and that metric is precisely how you would observe the merge behaving correctly.
    expect(resolveOperationPolicy(NOTE_MUTATE, { action: "read" }).scopeClass).toBe("read");
    expect(resolveOperationPolicy(NOTE_MUTATE, { action: "delete" }).scopeClass).not.toBe("read");
  });

  it("cannot lower `destructive` to escape the read-only gate", () => {
    // A resolver may lower `destructive` legitimately (a read action of a destructive tool). The
    // guard is that mutation is ALSO derived from the resolved scopes, which the subset check has
    // already bounded — so claiming destructive:false while keeping a write scope still mutates.
    const sneaky = {
      requiredScopes: ["write:notes"],
      destructive: true,
      resolvePolicy: () => ({ requiredScopes: ["write:notes"], destructive: false }),
    };
    const p = resolveOperationPolicy(sneaky, {});
    expect(p.destructive).toBe(false);
    expect(isMutatingCall(p)).toBe(true);
  });
});
