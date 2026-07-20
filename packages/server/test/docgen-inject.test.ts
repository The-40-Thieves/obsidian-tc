// docgen marker injection (THE-473): fills generated regions, preserves prose, idempotent.
import { describe, expect, it } from "vitest";
import { hasMarkers, injectGenerated } from "../scripts/docgen/inject";

const doc = `# Title

Hand-written intro that must never change.

<!-- BEGIN GENERATED: tools -->
old generated content
<!-- END GENERATED: tools -->

Hand-written footer.
`;

describe("injectGenerated (THE-473)", () => {
  it("replaces only the marked region and preserves surrounding prose", () => {
    const out = injectGenerated(doc, "tools", "NEW content");
    expect(out).toContain("Hand-written intro that must never change.");
    expect(out).toContain("Hand-written footer.");
    expect(out).toContain("NEW content");
    expect(out).not.toContain("old generated content");
    // markers themselves are kept
    expect(out).toContain("<!-- BEGIN GENERATED: tools -->");
    expect(out).toContain("<!-- END GENERATED: tools -->");
  });

  it("is idempotent — injecting the same content twice is a no-op", () => {
    const once = injectGenerated(doc, "tools", "stable content");
    const twice = injectGenerated(once, "tools", "stable content");
    expect(twice).toBe(once);
  });

  it("only touches its own named region", () => {
    const two = `<!-- BEGIN GENERATED: a -->\nA\n<!-- END GENERATED: a -->
<!-- BEGIN GENERATED: b -->\nB\n<!-- END GENERATED: b -->`;
    const out = injectGenerated(two, "a", "A2");
    expect(out).toContain("A2");
    expect(out).toContain("\nB\n"); // region b untouched
  });

  it("throws when the marker pair is missing or reversed", () => {
    expect(() => injectGenerated("# no markers", "tools", "x")).toThrow(/markers.*not found/i);
    const reversed = `<!-- END GENERATED: t -->\n<!-- BEGIN GENERATED: t -->`;
    expect(() => injectGenerated(reversed, "t", "x")).toThrow(/precedes/i);
  });

  it("hasMarkers detects a well-formed pair", () => {
    expect(hasMarkers(doc, "tools")).toBe(true);
    expect(hasMarkers(doc, "absent")).toBe(false);
  });
});
