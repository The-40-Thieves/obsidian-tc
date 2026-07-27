// THE-602: direct unit tests for the Tasks-plugin line model (src/tools/m4/tasks-model.ts).
// tasks.test.ts exercises this file only through the list_tasks/update_task tools, which never
// drives applyTaskSet's non-status fields, serializeTask's recur/start/scheduled legs, or the
// invalid-status / invalid-date rejection paths. These are pure parse/format helpers, so unit
// testing the exported functions directly gives the same real-behavior assertions (returned
// value / thrown-free state change) with less setup than routing through the tool-dispatch layer.
import { describe, expect, it } from "vitest";
import {
  applyTaskSet,
  daysSince,
  parseTaskLine,
  serializeTask,
  type TaskFields,
} from "../src/tools/m4/tasks-model";

describe("parseTaskLine", () => {
  it("returns null for an unrecognized status character", () => {
    // "z" is not in STATUS_BY_CHAR — covers the `if (!status) return null;` true leg.
    expect(parseTaskLine("- [z] mystery task")).toBeNull();
  });

  it("returns null for a line that is not a checkbox task at all", () => {
    expect(parseTaskLine("not a task")).toBeNull();
  });

  it("parses a task carrying only a due date (no scheduled/start/recur/priority)", () => {
    // Exercises the false leg of the scheduled/start/recur conditional spreads: those fields
    // must be genuinely absent from the returned object, not merely falsy.
    const f = parseTaskLine("- [ ] pay rent 📅 2026-06-20");
    expect(f).not.toBeNull();
    expect(f?.due).toBe("2026-06-20");
    expect(f?.scheduled).toBeUndefined();
    expect(f?.start).toBeUndefined();
    expect(f?.recur).toBeUndefined();
    expect("scheduled" in (f as object)).toBe(false);
    expect("start" in (f as object)).toBe(false);
    expect("recur" in (f as object)).toBe(false);
  });

  it("parses a task carrying scheduled, start and recur metadata", () => {
    const f = parseTaskLine("- [ ] water plants 🛫 2026-06-01 ⏳ 2026-06-02 🔁 every week");
    expect(f).not.toBeNull();
    expect(f?.start).toBe("2026-06-01");
    expect(f?.scheduled).toBe("2026-06-02");
    expect(f?.recur).toBe("every week");
  });
});

describe("serializeTask", () => {
  const base: TaskFields = {
    indent: "",
    marker: "-",
    status: "todo",
    description: "do the thing",
    tags: [],
  };

  it("round-trips a task carrying recur, start and scheduled metadata", () => {
    // Covers the true legs of the recur/start/scheduled `if` guards, which the plain
    // tasks.test.ts fixtures (due/priority only) never trigger.
    const f: TaskFields = {
      ...base,
      recur: "every week",
      start: "2026-06-01",
      scheduled: "2026-06-02",
    };
    const line = serializeTask(f);
    expect(line).toBe("- [ ] do the thing 🔁 every week 🛫 2026-06-01 ⏳ 2026-06-02");
    // And it must parse back to the same fields (real round-trip behavior, not just a string).
    const reparsed = parseTaskLine(line);
    expect(reparsed?.recur).toBe("every week");
    expect(reparsed?.start).toBe("2026-06-01");
    expect(reparsed?.scheduled).toBe("2026-06-02");
  });

  it("omits recur/start/scheduled when absent", () => {
    const line = serializeTask(base);
    expect(line).toBe("- [ ] do the thing");
  });
});

describe("applyTaskSet", () => {
  const base: TaskFields = {
    indent: "",
    marker: "-",
    status: "todo",
    description: "original text",
    tags: [],
  };

  it("sets description when provided", () => {
    const next = applyTaskSet(base, { description: "revised text" });
    expect(next.description).toBe("revised text");
  });

  it("sets due/scheduled/start/done/priority/recur to a truthy value", () => {
    const next = applyTaskSet(base, {
      due: "2026-07-01",
      scheduled: "2026-07-02",
      start: "2026-07-03",
      done: "2026-07-04",
      priority: "high",
      recur: "every day",
    });
    expect(next.due).toBe("2026-07-01");
    expect(next.scheduled).toBe("2026-07-02");
    expect(next.start).toBe("2026-07-03");
    expect(next.done).toBe("2026-07-04");
    expect(next.priority).toBe("high");
    expect(next.recur).toBe("every day");
  });

  it("clears due/scheduled/start/done/priority/recur when set to an empty string", () => {
    const withFields: TaskFields = {
      ...base,
      due: "2026-07-01",
      scheduled: "2026-07-02",
      start: "2026-07-03",
      done: "2026-07-04",
      priority: "high",
      recur: "every day",
    };
    const next = applyTaskSet(withFields, {
      due: "",
      scheduled: "",
      start: "",
      done: "",
      priority: "" as unknown as TaskFields["priority"],
      recur: "",
    });
    expect(next.due).toBeUndefined();
    expect(next.scheduled).toBeUndefined();
    expect(next.start).toBeUndefined();
    expect(next.done).toBeUndefined();
    expect(next.priority).toBeUndefined();
    expect(next.recur).toBeUndefined();
  });

  it("leaves status untouched when not provided in the set", () => {
    const next = applyTaskSet(base, { description: "x" });
    expect(next.status).toBe("todo");
  });

  it("adds a tag lacking a leading # and one already carrying it, skipping a duplicate", () => {
    const next = applyTaskSet(base, { add_tags: ["work", "#urgent", "work"] });
    expect(next.description).toBe("original text #work #urgent");
    expect(next.tags).toEqual(["#work", "#urgent"]);
  });

  it("removes a tag whether given with or without a leading #", () => {
    const withTags: TaskFields = { ...base, description: "original text #work #urgent" };
    const next = applyTaskSet(withTags, { remove_tags: ["work", "#urgent"] });
    expect(next.description).toBe("original text");
    expect(next.tags).toEqual([]);
  });
});

describe("daysSince", () => {
  it("computes whole days elapsed for a valid ISO date", () => {
    const now = Date.parse("2026-01-10T00:00:00Z");
    expect(daysSince("2026-01-01", now)).toBe(9);
  });

  it("returns 0 for an unparseable date string", () => {
    // Covers the `if (Number.isNaN(then)) return 0;` true leg.
    expect(daysSince("not-a-date", Date.now())).toBe(0);
  });
});
