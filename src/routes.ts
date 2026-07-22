/**
 * Host route shapes for this plugin's `page` slot.
 *
 * Pure string logic, deliberately free of React and of the SDK, so the manifest
 * (which registers the route) and the UI (which links to it) share one source
 * of truth and a unit test can pin the shape without a DOM.
 */

/**
 * URL segment the `page` and `routeSidebar` slots register under. Host
 * constraint: lowercase single-segment slug (`^[a-z0-9][a-z0-9-]*$`).
 */
export const PAGE_ROUTE = "file-access";

/** Query param naming the agent whose access is being edited. */
export const AGENT_PARAM = "agent";

/**
 * Path to the plugin page, relative to the company prefix — pass through
 * `useHostNavigation().linkProps()` / `resolveHref()` to get `/:companyPrefix/...`.
 *
 * The page mounts on the host's `:pluginRoutePath/*` route, a top-level sibling
 * of /goals, /costs and /inbox. So the path is `/file-access`.
 *
 * It is emphatically NOT `/plugins/file-access`. That matches a *different*
 * host route, `plugins/:pluginId`, which resolves its segment as a plugin
 * **UUID**. A routePath never matches one, and on the miss the host redirects
 * to `/company/settings/instance/plugins/file-access`, whose plugin-detail
 * query 404s and leaves the screen stuck on "Loading plugin details…"
 * indefinitely. Only the routePath form also renders the route sidebar: the
 * host derives the page/sidebar pairing key from the `pluginRoutePath` param,
 * which the UUID route does not have.
 */
export function pageHref(agentId?: string): string {
  const base = `/${PAGE_ROUTE}`;
  return agentId ? `${base}?${AGENT_PARAM}=${encodeURIComponent(agentId)}` : base;
}

/**
 * Whether a host pathname is on this plugin's page route. Tolerates the
 * company prefix being present (`/PAP/file-access`) or absent (`/file-access`),
 * and any trailing splat the host appends.
 */
export function isPluginRoute(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);
  return segments[0] === PAGE_ROUTE || segments[1] === PAGE_ROUTE;
}

/** Agent id carried by a location's search string, or null when unscoped. */
export function agentIdFromSearch(search: string): string | null {
  return new URLSearchParams(search).get(AGENT_PARAM);
}
