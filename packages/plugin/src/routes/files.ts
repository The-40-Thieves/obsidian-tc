// Open a vault file in the workspace — the companion half of the server's show_file_in_obsidian.
// The server has already put the path through the vault's read ACL; this route still refuses
// anything that is not a plain vault-relative path (absolute, traversal, NUL, a URI), because the
// route is reachable by anyone holding the LRA key. It takes a path and only ever opens an EXISTING
// file (fileByPath narrows to TFile), so it cannot create a note, run a command, or follow a URI.
import { body, fail, ok, str } from "./envelope";
import { fileByPath, type InternalApp, type RouteDef } from "./types";

/** True unless `p` is a non-empty vault-relative path with no traversal, NUL, drive/root or URI scheme. */
function plainRelativePath(p: string): boolean {
  if (p === "" || p.includes("\0")) return false;
  if (p.startsWith("/") || p.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(p)) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(p)) return false;
  return !p.split(/[\\/]+/).some((seg) => seg === "..");
}

export function buildFilesRoutes(app: InternalApp): RouteDef[] {
  return [
    {
      method: "post",
      path: "/files/open",
      handler: async (req, res) => {
        const path = str(body(req), "path");
        if (path === undefined || !plainRelativePath(path))
          return fail(res, "invalid_input", "path must be a vault-relative file path");
        const file = fileByPath(app, path);
        if (!file) return fail(res, "note_not_found", "no such file in the vault", { path });
        const leaf = app.workspace.getLeaf(false);
        await leaf.openFile(file);
        await app.workspace.revealLeaf(leaf);
        ok(res, { opened: true, path: file.path });
      },
    },
  ];
}
