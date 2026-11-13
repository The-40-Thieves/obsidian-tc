// TC Bridge (id tc-bridge, formerly reliquary-tc / "Reliquary-TC" — renamed THE-943 so
// the plugin can list in the community directory, whose rules ban "obsidian" in a plugin id) —
// companion plugin entry point (THE-180, G2.2 §3.1). It does NOT open a port of its own: it
// attaches the /obsidian-tc/v1/* bridge routes onto the Local REST API plugin's HTTP server,
// reusing that plugin's TLS + bearer-token auth (the shared key the MCP server reads from
// config/env). If Local REST API is absent or exposes no extension surface, the routes are simply
// not registered — the server's probe then reports the companion unreachable and every bridge
// tool degrades. The plugin holds no secrets and logs none.
//
// Route lifecycle (src/registration.ts): the routes are released in onunload, and re-attached
// whenever Local REST API (re)loads, so a reload, an in-place update, or Local REST API loading
// after this plugin all end with exactly one copy of this build's routes mounted.
//
// NOTE: the bridge route prefix (/obsidian-tc/v1) is the SERVER's DEFAULT_API_PREFIX
// (packages/server) and is NOT part of the Obsidian manifest id/name the rename covers — changing
// it is a server-side wire-protocol change out of THE-943's scope, not a leftover.
import { type EventRef, Notice, Plugin } from "obsidian";
import { OLD_PLUGIN_ID, runMigrationAndConflictGuard } from "./migration";
import {
  BRIDGE_PREFIX,
  type BridgeRegistration,
  type LocalRestApiPlugin,
  registerBridgeRoutes,
} from "./registration";
import { buildRoutes, type RouteDef } from "./routes";

const LRA_ID = "obsidian-local-rest-api";
/** Fired by Local REST API at the end of its onload, after its extension API is usable. */
const LRA_LOADED_EVENT = "obsidian-local-rest-api:loaded";

interface AppWithPlugins {
  plugins?: {
    plugins: Record<string, LocalRestApiPlugin | undefined>;
    // Undocumented Obsidian internal (not in the public d.ts, same as `plugins.plugins` above):
    // the set of currently-ENABLED plugin ids, keyed the same as `plugins.plugins`. Used only by
    // the conflict guard (THE-943) to detect the old id (OLD_PLUGIN_ID) still running alongside
    // this one. Duck-typed with the same fail-open posture as the rest of this file: if the shape
    // has moved, isOldPluginEnabled() below reports "not enabled" rather than blocking startup.
    enabledPlugins?: { has(id: string): boolean };
  };
}
interface AnyEventSource {
  on(name: string, callback: () => void): EventRef;
}

export default class TcBridge extends Plugin {
  private registration: BridgeRegistration | null = null;
  /** Set by onunload; onload awaits the migration, and an unload can land during that await. */
  private unloaded = false;

  override async onload(): Promise<void> {
    // THE-282: startup shape self-check over the Obsidian internals this plugin duck-types.
    // A failed check degrades honestly (one console.warn + surfaced on /probe) instead of
    // throwing route-level TypeErrors when internals move between Obsidian versions.
    const shapeWarnings: string[] = [];
    const anyApp = this.app as unknown as {
      commands?: { listCommands?: unknown };
      plugins?: { plugins?: unknown; enabledPlugins?: unknown };
    };
    if (typeof anyApp.commands?.listCommands !== "function")
      shapeWarnings.push("app.commands.listCommands is not a function");
    if (typeof anyApp.plugins?.plugins !== "object" || anyApp.plugins?.plugins === null)
      shapeWarnings.push("app.plugins.plugins is not an object");
    const enabledPluginsOk =
      typeof (anyApp.plugins?.enabledPlugins as { has?: unknown } | undefined)?.has === "function";
    if (!enabledPluginsOk) shapeWarnings.push("app.plugins.enabledPlugins is not a Set-like");

    // THE-943: rename settings migration + old-id conflict guard. Runs before route registration
    // so a detected conflict never registers duplicate bridge routes.
    const proceed = await runMigrationAndConflictGuard({
      adapter: this.app.vault.adapter,
      configDir: this.app.vault.configDir,
      pluginDir: this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`,
      notice: (message) => new Notice(message, 0),
      isOldPluginEnabled: () =>
        enabledPluginsOk &&
        ((this.app as unknown as AppWithPlugins).plugins?.enabledPlugins?.has(OLD_PLUGIN_ID) ??
          false),
    });
    if (!proceed || this.unloaded) return;

    const routes = buildRoutes(this.app, this.manifest.version, shapeWarnings);
    if (shapeWarnings.length)
      console.warn(
        `[tc-bridge] degraded: ${shapeWarnings.join("; ")} — Obsidian internals may have moved; some bridges will degrade.`,
      );

    // Local REST API rebuilds its server (and drops every extension route) each time it loads, and
    // it may load after this plugin. Re-attach on its loaded event in both cases.
    this.registerEvent(
      (this.app.workspace as unknown as AnyEventSource).on(LRA_LOADED_EVENT, () =>
        this.attach(routes),
      ),
    );
    this.attach(routes);
  }

  override onunload(): void {
    this.unloaded = true;
    this.registration?.release();
    this.registration = null;
  }

  /** (Re)attach the bridge routes, releasing any previous registration first. */
  private attach(routes: RouteDef[]): void {
    this.registration?.release();
    const lra = (this.app as unknown as AppWithPlugins).plugins?.plugins?.[LRA_ID];
    this.registration = registerBridgeRoutes(lra, this.manifest, routes);
    if (this.registration === null) {
      // NOTE: when registration fails, /probe was never attached either — console is the only
      // surface for this failure mode (documented, THE-282).
      console.warn(
        "[tc-bridge] Local REST API is not loaded (or exposes no extension API); bridge routes will be registered when it loads. Install/enable the Local REST API plugin.",
      );
      return;
    }
    console.debug(
      `[tc-bridge] registered ${this.registration.count} bridge routes under ${BRIDGE_PREFIX} (${this.registration.via})`,
    );
  }
}
