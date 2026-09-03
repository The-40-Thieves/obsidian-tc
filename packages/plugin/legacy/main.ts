// Final release of the OLD `obsidian-tc` id (THE-943 — renamed to TC Bridge / tc-bridge; see
// ../src/main.ts's header and ../README.md's "Renamed to TC Bridge" section). This build does
// nothing except show one notice pointing already-installed users at the new plugin, then never
// updates again under this id. It bridges nothing, registers no routes, holds no settings.
import { Notice, Plugin } from "obsidian";
import { LEGACY_NOTICE_MESSAGE } from "./notice";

export default class ObsidianTcSunset extends Plugin {
  override onload(): void {
    // duration 0 = sticky (Obsidian's Notice never auto-dismisses at 0ms) — this is a one-time
    // install-time signal the user needs to actually read, not a toast that can flash past.
    new Notice(LEGACY_NOTICE_MESSAGE, 0);
    console.warn(`[obsidian-tc] ${LEGACY_NOTICE_MESSAGE}`);
  }
}
