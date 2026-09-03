// THE-943: settings migration + conflict guard for the obsidian-tc -> tc-bridge rename.
//
// main.ts extends Obsidian's `Plugin`, a VALUE import from `obsidian` the test mock (see
// test/__mocks__/obsidian.ts's header) deliberately does not export, so main.ts cannot be
// imported under vitest at all (it is excluded from coverage for exactly this reason). This
// logic is therefore extracted into src/migration.ts as pure functions parametrized over a
// minimal adapter surface, with no value import from `obsidian` — the same pattern routes.ts
// uses to stay testable. main.ts wires it to `this.app.vault.adapter` / `this.manifest` /
// `Notice` at runtime; that wiring is manual-verification surface (THE-282's precedent).
import { describe, expect, it } from "vitest";
import { NEW_PLUGIN_ID, OLD_PLUGIN_ID, runMigrationAndConflictGuard } from "../src/migration";

function fakeAdapter(files: Record<string, string> = {}) {
  const store = { ...files };
  const writes: Record<string, string> = {};
  return {
    store,
    writes,
    exists: async (path: string) => path in store,
    read: async (path: string) => {
      if (!(path in store)) throw new Error(`no such file: ${path}`);
      return store[path] as string;
    },
    write: async (path: string, data: string) => {
      store[path] = data;
      writes[path] = data;
    },
  };
}

const OLD_DATA_PATH = `.obsidian/plugins/${OLD_PLUGIN_ID}/data.json`;
const NEW_DATA_PATH = `.obsidian/plugins/${NEW_PLUGIN_ID}/data.json`;

describe("runMigrationAndConflictGuard — settings migration", () => {
  it("copies old data.json to the new plugin's data.json and shows exactly one notice", async () => {
    const adapter = fakeAdapter({ [OLD_DATA_PATH]: '{"apiKey":"secret"}' });
    const notices: string[] = [];
    const proceed = await runMigrationAndConflictGuard({
      adapter,
      configDir: ".obsidian",
      pluginDir: `.obsidian/plugins/${NEW_PLUGIN_ID}`,
      notice: (m) => notices.push(m),
      isOldPluginEnabled: () => false,
    });
    expect(proceed).toBe(true);
    expect(adapter.writes[NEW_DATA_PATH]).toBe('{"apiKey":"secret"}');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/migrated/i);
  });

  it("does nothing when the new data.json already exists (no clobber, no notice)", async () => {
    const adapter = fakeAdapter({
      [OLD_DATA_PATH]: '{"apiKey":"old"}',
      [NEW_DATA_PATH]: '{"apiKey":"already-configured"}',
    });
    const notices: string[] = [];
    const proceed = await runMigrationAndConflictGuard({
      adapter,
      configDir: ".obsidian",
      pluginDir: `.obsidian/plugins/${NEW_PLUGIN_ID}`,
      notice: (m) => notices.push(m),
      isOldPluginEnabled: () => false,
    });
    expect(proceed).toBe(true);
    expect(adapter.store[NEW_DATA_PATH]).toBe('{"apiKey":"already-configured"}');
    expect(notices).toHaveLength(0);
  });

  it("does nothing when the old data.json does not exist (fresh install)", async () => {
    const adapter = fakeAdapter({});
    const notices: string[] = [];
    const proceed = await runMigrationAndConflictGuard({
      adapter,
      configDir: ".obsidian",
      pluginDir: `.obsidian/plugins/${NEW_PLUGIN_ID}`,
      notice: (m) => notices.push(m),
      isOldPluginEnabled: () => false,
    });
    expect(proceed).toBe(true);
    expect(NEW_DATA_PATH in adapter.store).toBe(false);
    expect(notices).toHaveLength(0);
  });
});

describe("runMigrationAndConflictGuard — conflict guard", () => {
  it("refuses to start (returns false) and names the conflict when the old plugin is enabled", async () => {
    const adapter = fakeAdapter({ [OLD_DATA_PATH]: '{"apiKey":"secret"}' });
    const notices: string[] = [];
    const proceed = await runMigrationAndConflictGuard({
      adapter,
      configDir: ".obsidian",
      pluginDir: `.obsidian/plugins/${NEW_PLUGIN_ID}`,
      notice: (m) => notices.push(m),
      isOldPluginEnabled: () => true,
    });
    expect(proceed).toBe(false);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(new RegExp(OLD_PLUGIN_ID));
    expect(notices[0]).toMatch(/TC Bridge/);
  });

  it("skips the migration copy entirely when refusing to start (conflict wins over migration)", async () => {
    const adapter = fakeAdapter({ [OLD_DATA_PATH]: '{"apiKey":"secret"}' });
    const proceed = await runMigrationAndConflictGuard({
      adapter,
      configDir: ".obsidian",
      pluginDir: `.obsidian/plugins/${NEW_PLUGIN_ID}`,
      notice: () => {},
      isOldPluginEnabled: () => true,
    });
    expect(proceed).toBe(false);
    expect(NEW_DATA_PATH in adapter.store).toBe(false);
  });
});
