// The resource URLs this server answers to: `auth.resource` (R) and R/<surface> for each tool-budget
// profile URL (`/mcp/<surface>`, mcp/tool-profiles.ts). A client signs in at the URL it was given and
// compares the Protected Resource Metadata `resource` with it, so each of those URLs has to be a
// resource the authorization server will issue for and the resource server will accept.
//
// ONE definition: the authorization request, the token and refresh grants, revocation, the access-token
// verifier, the external-server audience and the PRM routes all call `allowedResources` /
// `matchResource` instead of comparing against `auth.resource` themselves.
//
// Profiles change only what a tool list ADVERTISES; every surface dispatches through the same scope and
// folder-ACL checks. So the audience is the same set on every surface: a token for R/essentials is
// accepted on /mcp/full. This is not a path binding and not an escalation, it is the set of names for
// one resource.
import { URL_SURFACE_NAMES } from "../mcp/tool-profiles";
import { sameResource } from "./as-clients";

/** R/<surface>, or undefined for an unknown surface or an R with no path to hang a surface off
 *  (a root, query-bearing or already profile-named URL derives nothing and keeps R alone). */
export function surfaceResource(resource: string, surface: string): string | undefined {
  if (!URL_SURFACE_NAMES.includes(surface)) return undefined;
  let u: URL;
  try {
    u = new URL(resource);
  } catch {
    return undefined;
  }
  if (u.search !== "" || u.hash !== "") return undefined;
  const base = u.pathname.replace(/\/+$/, "");
  // An R that already ends in a profile name (auth.resource: https://host/mcp/essentials) IS one
  // profile's URL: nothing hangs off it, and R/essentials/<surface> would name no route.
  if (base === "" || URL_SURFACE_NAMES.includes(base.slice(base.lastIndexOf("/") + 1))) {
    return undefined;
  }
  return `${u.origin}${base}/${surface}`;
}

/** Every resource URL for `resource`: R first, exactly as configured, then R/<surface> in the order of
 *  the profile list. */
export function allowedResources(resource: string): string[] {
  return [
    resource,
    ...URL_SURFACE_NAMES.flatMap((name) => {
      const s = surfaceResource(resource, name);
      return s === undefined ? [] : [s];
    }),
  ];
}

/** The member of `allowedResources(resource)` that `requested` names (RFC 8707 comparison: scheme and
 *  host case-insensitive, everything else exact), or undefined. Exact against the derived set, never a
 *  prefix test; the member is returned so callers use the canonical string, not the client's spelling.
 *
 *  ONE concession, made here and nowhere else: a requested URL that is a member plus exactly one trailing
 *  slash names that member (Perplexity sends `https://host/mcp/` for `https://host/mcp`). Two slashes, a
 *  backslash, a query or fragment after the slash, or any other suffix still name nothing, and the answer
 *  is the member, so `aud` stays the canonical string. */
export function matchResource(requested: string, resource: string): string | undefined {
  const members = allowedResources(resource);
  const exact = members.find((r) => sameResource(requested, r));
  if (exact !== undefined) return exact;
  if (!requested.endsWith("/") || requested.endsWith("//") || requested.includes("\\")) {
    return undefined;
  }
  const bare = requested.slice(0, -1);
  return members.find((r) => sameResource(bare, r));
}
