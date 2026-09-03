// Settings migration + conflict guard for the obsidian-tc -> tc-bridge rename (THE-943).
//
// Obsidian's community-directory rules ban the word "obsidian" in a plugin id (verified via
// context7 against obsidianmd/obsidian-developer-docs, 2026-09-03: "must not contain 'obsidian'",
// Reference/Manifest.md), so the companion plugin's id changed from `obsidian-tc` ("Obsidian
// Turbocharged") to `tc-bridge` ("TC Bridge"). Obsidian keys a plugin's persisted settings by its
// id (`.obsidian/plugins/<id>/data.json`), so a bare rename would silently drop every existing
// user's configuration (LRA API key, etc.) on upgrade — this module is what prevents that.
//
// Extracted as pure functions taking a minimal adapter surface (not `this.app.vault.adapter`
// directly, not a value import from `obsidian`) so it is testable under vitest: main.ts `extends
// Plugin`, a value the test mock (test/__mocks__/obsidian.ts) deliberately does not export, so
// main.ts itself cannot load under vitest at all. See test/migration.test.ts.

export const OLD_PLUGIN_ID = "obsidian-tc";
export const NEW_PLUGIN_ID = "tc-bridge";

/** The slice of Obsidian's `DataAdapter` this module needs. */
export interface MigrationAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
}

export interface MigrationDeps {
  adapter: MigrationAdapter;
  /** `this.app.vault.configDir`, e.g. ".obsidian". */
  configDir: string;
  /** `this.manifest.dir`, e.g. ".obsidian/plugins/tc-bridge". */
  pluginDir: string;
  notice: (message: string) => void;
  /** Whether the OLD plugin id is currently enabled (duck-typed `app.plugins.enabledPlugins`). */
  isOldPluginEnabled: () => boolean;
}

/**
 * Runs the conflict guard first, then (only if it passes) the settings migration.
 *
 * Returns `false` when startup must be refused — the old `obsidian-tc` plugin is still enabled,
 * so both plugins would register the same bridge routes on Local REST API. Migration is skipped
 * entirely in that case: copying settings for a plugin instance that is about to refuse to start
 * would just leave a half-migrated data.json for no benefit.
 *
 * Returns `true` when the caller should proceed with normal onload. If the old plugin's
 * `data.json` exists and the new plugin's does not yet, it is copied over (once) and a single
 * notice is shown.
 */
export async function runMigrationAndConflictGuard(deps: MigrationDeps): Promise<boolean> {
  if (deps.isOldPluginEnabled()) {
    deps.notice(
      `TC Bridge refuses to start: the old "${OLD_PLUGIN_ID}" plugin (Obsidian Turbocharged) is ` +
        "still enabled. Disable it in Community Plugins before using TC Bridge — running both " +
        "together would register the same bridge routes twice.",
    );
    return false;
  }

  const oldDataPath = `${deps.configDir}/plugins/${OLD_PLUGIN_ID}/data.json`;
  const newDataPath = `${deps.pluginDir}/data.json`;
  const [oldExists, newExists] = await Promise.all([
    deps.adapter.exists(oldDataPath),
    deps.adapter.exists(newDataPath),
  ]);
  if (oldExists && !newExists) {
    const data = await deps.adapter.read(oldDataPath);
    await deps.adapter.write(newDataPath, data);
    deps.notice(
      `TC Bridge: migrated settings from the old "Obsidian Turbocharged" plugin (${OLD_PLUGIN_ID}).`,
    );
  }

  return true;
}
