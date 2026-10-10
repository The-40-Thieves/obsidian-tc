// Description stability: claude.ai keys "Always allow" to a hash of the tool description, and Visual
// Studio resets approvals on list_changed, so editing an advertised description makes every user
// re-approve that tool. test/tool-descriptions.snapshot.json holds the full text of every
// description a client can be shown (flat, triad, triad-no-vault, domain; essentials and core
// re-advertise flat verbatim), sorted, one `<surface>/<tool>` entry per line.
//
// This suite is the STALENESS half: the live text must equal the committed file. The
// ACKNOWLEDGEMENT half (an entry that changed vs origin/main must be named by
// `tool-description-change:` in a changes/ fragment) is scripts/check-tool-description-acks.mjs.
//
// To change a description on purpose: `bun run tool-descriptions:update` (packages/server), commit
// the snapshot, and add `tool-description-change: <tool>[, <tool>]` to your changes/ fragment.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildFullRegistry } from "../scripts/docgen/build-registry";
import {
  advertisedSurfaces,
  descriptionEntries,
  renderDescriptionSnapshot,
  SNAPSHOT_SURFACES,
} from "../scripts/docgen/tool-surface";
import { REGISTERED_TOOL_COUNT } from "./registered-tool-count";

const SNAPSHOT_FILE = new URL("./tool-descriptions.snapshot.json", import.meta.url);
const surfaces = advertisedSurfaces(buildFullRegistry());
const live = descriptionEntries(surfaces);
const committedText = readFileSync(SNAPSHOT_FILE, "utf8");

describe("tool-description snapshot", () => {
  it("matches the live advertised descriptions (run `bun run tool-descriptions:update`)", () => {
    const committed = JSON.parse(committedText) as Record<string, string>;
    // Name the entries, not just "not equal": a 60 KB string diff says nothing about which tool.
    const changed = Object.keys(live).filter((k) => k in committed && committed[k] !== live[k]);
    expect({
      changed,
      missingFromSnapshot: Object.keys(live).filter((k) => !(k in committed)),
      staleInSnapshot: Object.keys(committed).filter((k) => !(k in live)),
    }).toEqual({ changed: [], missingFromSnapshot: [], staleInSnapshot: [] });
    expect(committedText).toBe(renderDescriptionSnapshot(live));
  });

  it("existence floor: every registered tool is covered on the flat surface, plus the other surfaces", () => {
    const keys = Object.keys(live);
    expect(keys.filter((k) => k.startsWith("flat/")).length).toBe(REGISTERED_TOOL_COUNT);
    for (const s of SNAPSHOT_SURFACES) expect(keys.some((k) => k.startsWith(`${s}/`))).toBe(true);
    expect(live["triad/find_capability"]).toMatch(/obsidian-tc:\/\/catalog/);
    expect(live["triad-no-vault/find_capability"]).not.toMatch(/obsidian-tc:\/\/catalog/);
    expect(live["domain/notes"]).toMatch(/- read_note:/);
    expect(live["flat/read_note"]).toBeTruthy();
    expect(Object.values(live).every((d) => d.length > 0)).toBe(true);
  });

  it("is stable on disk: sorted by code unit, exactly one entry per line", () => {
    const lines = committedText.split("\n");
    expect(lines[0]).toBe("{");
    expect(lines.at(-2)).toBe("}");
    expect(lines.at(-1)).toBe("");
    const rows = lines.slice(1, -2);
    expect(rows.length).toBe(Object.keys(live).length);
    const keys = rows.map((r) => Object.keys(JSON.parse(`{${r.replace(/,$/, "")}}`))[0]);
    expect(keys).toEqual([...keys].sort());
  });
});

describe("tool-description snapshot: the gate fails on a changed description (red case)", () => {
  it("a one-word edit to any tool changes the rendered snapshot and names that entry", () => {
    const edited: Record<string, string> = {
      ...live,
      "flat/read_note": `${live["flat/read_note"]} (edited)`,
    };
    expect(renderDescriptionSnapshot(edited)).not.toBe(committedText);
    const changed = Object.keys(edited).filter((k) => edited[k] !== live[k]);
    expect(changed).toEqual(["flat/read_note"]);
  });

  it("a changed member description also moves the domain entry that lists it", () => {
    const fresh = buildFullRegistry();
    const read = fresh.list().find((d) => d.name === "read_note");
    if (!read) throw new Error("read_note not registered");
    const original = read.description;
    (read as { description: string }).description = `Reworded first sentence. ${original}`;
    try {
      const after = descriptionEntries(advertisedSurfaces(fresh));
      expect(after["flat/read_note"]).not.toBe(live["flat/read_note"]);
      expect(after["domain/notes"]).not.toBe(live["domain/notes"]);
    } finally {
      (read as { description: string }).description = original;
    }
  });
});
