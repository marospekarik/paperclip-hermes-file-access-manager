import { describe, expect, test } from "bun:test";
import manifest from "../src/manifest.ts";
import {
  AGENT_PARAM,
  PAGE_ROUTE,
  agentIdFromSearch,
  isPluginRoute,
  pageHref,
} from "../src/routes.ts";

describe("plugin page route", () => {
  test("href targets the routePath route, not the plugin-id route", () => {
    // Regression: `/plugins/<routePath>` matches the host's `plugins/:pluginId`
    // route, which resolves the segment as a plugin UUID. The miss redirects to
    // the plugin-detail page, whose query 404s and hangs on
    // "Loading plugin details…" forever.
    expect(pageHref()).toBe(`/${PAGE_ROUTE}`);
    expect(pageHref()).not.toStartWith("/plugins/");
    expect(pageHref("abc")).not.toStartWith("/plugins/");
  });

  test("agent selection round-trips through the query string", () => {
    const href = pageHref("f3f5b8f6-78e3-460d-b590-0b64feb6f7e4");
    expect(href).toBe(`/${PAGE_ROUTE}?${AGENT_PARAM}=f3f5b8f6-78e3-460d-b590-0b64feb6f7e4`);
    expect(agentIdFromSearch(href.slice(href.indexOf("?")))).toBe(
      "f3f5b8f6-78e3-460d-b590-0b64feb6f7e4",
    );
  });

  test("agent ids are percent-encoded", () => {
    expect(pageHref("a b&c=d")).toBe(`/${PAGE_ROUTE}?${AGENT_PARAM}=a%20b%26c%3Dd`);
    expect(agentIdFromSearch(`?${AGENT_PARAM}=a%20b%26c%3Dd`)).toBe("a b&c=d");
  });

  test("no agent param means the unscoped profile view", () => {
    expect(agentIdFromSearch("")).toBeNull();
    expect(agentIdFromSearch("?other=1")).toBeNull();
  });

  test("route matches with and without a company prefix", () => {
    expect(isPluginRoute(`/${PAGE_ROUTE}`)).toBe(true);
    expect(isPluginRoute(`/PAP/${PAGE_ROUTE}`)).toBe(true);
    expect(isPluginRoute(`/PAP/${PAGE_ROUTE}/nested`)).toBe(true);
    expect(isPluginRoute("/PAP/agents/abc")).toBe(false);
    expect(isPluginRoute(`/PAP/agents/${PAGE_ROUTE}`)).toBe(false);
    expect(isPluginRoute("/dashboard")).toBe(false);
  });
});

describe("manifest route wiring", () => {
  const slots = manifest.ui?.slots ?? [];

  test("exactly one page slot, on PAGE_ROUTE", () => {
    const page = slots.filter((s) => s.type === "page");
    expect(page).toHaveLength(1);
    expect(page[0]!.routePath).toBe(PAGE_ROUTE);
  });

  test("no routeSidebar is declared", () => {
    // Regression: on mobile the host renders `hasRouteSidebar ? pluginSidebar
    // : appSidebar` — a routeSidebar replaces the app nav in the drawer rather
    // than sitting beside it, stranding the user without a menu.
    expect(slots.some((s) => s.type === "routeSidebar")).toBe(false);
  });

  test("the sidebar slot's capability is declared", () => {
    expect(slots.some((s) => s.type === "sidebar")).toBe(true);
    expect(manifest.capabilities).toContain("ui.sidebar.register");
  });
});
