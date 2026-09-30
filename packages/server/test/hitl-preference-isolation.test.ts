// The confirmation level is a SECURITY FLOOR. It must never be a learned preference: no HITL gate
// may read the experiential preference store (`preference_profile` and its siblings), the reflect
// pass that writes it, or anything that derives from either. Learning what a human tends to approve
// and then prompting less is precisely the failure this gate exists to make a build break.
//
// A source-scan gate, so it carries its own floor: it fails if a listed gate file is missing or the
// `elicit*.ts` glob stops finding files (a renamed gate would otherwise scan nothing and pass), and
// its detector is proven on planted fixtures, including a scratch copy of a real gate file.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..", "src");

/** Named gate files. Everything HITL enforces or records lives in one of these. */
const GATE_FILES = [
  "mcp/registry/policy-gates.ts",
  "mcp/registry/resolve-target.ts",
  "mcp/registry/hitl-declaration.ts",
  "vault/hitl.ts",
  "hitl-telemetry.ts",
  "doctor/hitl-confirmations.ts",
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** `elicit*.ts` anywhere under src: elicit.ts, elicit-drift.ts, mcp/elicit-form.ts, the CLI mint... */
const elicitFiles = () =>
  walk(SRC).filter((p) => /^elicit[^/\\]*\.ts$/.test(p.split(/[\\/]/).pop() ?? ""));

const FORBIDDEN: Array<[string, RegExp]> = [
  ["a preference table or column set", /preference_\w+/i],
  ["a preference identifier", /\b(?:preference[A-Z]|Preference[A-Z]|PREFERENCE_)\w*/],
  ["the reflect pass", /reflect\.ts|experiential\/reflect|from\s+["']\.\/reflect["']/],
  ["an experiential module import", /from\s+["'][^"']*experiential\//],
];

function preferenceCoupling(source: string): string[] {
  const hits: string[] = [];
  for (const [label, re] of FORBIDDEN) {
    const m = re.exec(source);
    if (m) hits.push(`${label}: ${m[0]}`);
  }
  return hits;
}

describe("HITL gates never touch learned preferences", () => {
  it("floor: every named gate file exists and the elicit*.ts glob finds the gate modules", () => {
    for (const f of GATE_FILES) expect(existsSync(join(SRC, f)), f).toBe(true);
    const names = elicitFiles().map((p) => relative(SRC, p).replaceAll("\\", "/"));
    for (const expected of [
      "elicit.ts",
      "elicit-drift.ts",
      "elicit-request-state.ts",
      "mcp/elicit-form.ts",
      "mcp/elicit-token.ts",
      "cli/commands/elicit-mint.ts",
    ]) {
      expect(names, expected).toContain(expected);
    }
  });

  it("no gate file references the preference store, reflect, or an experiential module", () => {
    const files = [...GATE_FILES.map((f) => join(SRC, f)), ...elicitFiles()];
    expect(files.length).toBeGreaterThanOrEqual(12);
    const violations = files.flatMap((f) =>
      preferenceCoupling(readFileSync(f, "utf8")).map((h) => `${relative(SRC, f)} -> ${h}`),
    );
    expect(violations).toEqual([]);
  });

  describe("the detector fires (RED on planted coupling)", () => {
    const planted = [
      'import { applyPreferenceDeltas } from "../../experiential/reflect";',
      'import { reflect } from "./reflect";',
      "db.prepare('SELECT value FROM preference_profile WHERE key = ?')",
      "const skip = preferenceProfile.get(tool) === 'approve';",
      "const row: PreferenceProfileRow = load();",
      'import { redactSecrets } from "../experiential/redact";',
    ];
    for (const line of planted) {
      it(`flags: ${line}`, () => {
        expect(preferenceCoupling(line)).not.toEqual([]);
      });
    }

    it("flags a planted import inside a scratch copy of a REAL gate file", () => {
      const real = readFileSync(join(SRC, "mcp/registry/policy-gates.ts"), "utf8");
      expect(preferenceCoupling(real)).toEqual([]);
      const tampered = `import { preferenceProfile } from "../../experiential/reflect";\n${real}`;
      expect(preferenceCoupling(tampered).length).toBeGreaterThanOrEqual(2);
    });

    it("does not flag the prose that states the rule", () => {
      expect(preferenceCoupling("// never a learned preference; a security floor")).toEqual([]);
    });
  });
});
