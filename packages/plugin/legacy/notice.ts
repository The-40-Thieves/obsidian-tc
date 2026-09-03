// THE-943: the message shown by the final `obsidian-tc` release. Pulled out of legacy/main.ts (a
// plain string constant, no `obsidian` import) so it stays testable under vitest — main.ts
// `extends Plugin`, a value the vitest obsidian mock deliberately does not export, so main.ts
// itself cannot load there. See test/legacy-notice.test.ts.
export const LEGACY_NOTICE_MESSAGE =
  'This plugin has been renamed to "TC Bridge" (id tc-bridge) so it can list in the Obsidian ' +
  "community directory. Install TC Bridge from Community Plugins, then disable this plugin — " +
  "it no longer bridges anything and will not receive further updates under this id.";
