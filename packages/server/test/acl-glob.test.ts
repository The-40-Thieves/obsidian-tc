import { describe, expect, it } from "vitest";
import { globMatch } from "../src/acl";

// D4: the `**` sentinel must not alias a literal space in a glob or path.
describe("globMatch ** sentinel (D4)", () => {
  it("treats a literal space in the glob as literal, not a wildcard", () => {
    expect(globMatch("My Notes/*", "My Notes/a.md")).toBe(true);
    expect(globMatch("My Notes/*", "MyXNotes/a.md")).toBe(false);
  });

  it("still spans path separators for a real **", () => {
    expect(globMatch("notes/**", "notes/a/b/c.md")).toBe(true);
    expect(globMatch("notes/**", "notes/a.md")).toBe(true);
    expect(globMatch("notes/**", "other/a.md")).toBe(false);
  });

  it("single * does not cross / and an adjacent space stays literal", () => {
    expect(globMatch("a b/*.md", "a b/c.md")).toBe(true);
    expect(globMatch("a b/*.md", "a/b/c.md")).toBe(false);
  });

  it("a literal space between single-stars is literal, * is [^/]*", () => {
    expect(globMatch("* *", "x y")).toBe(true);
    expect(globMatch("* *", "xy")).toBe(false);
  });
});
