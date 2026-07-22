import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

import { PAGE_ROUTE } from "./routes.js";

const manifest: PaperclipPluginManifestV1 = {
  id: "ordillect.file-access-manager",
  apiVersion: 1,
  version: "0.5.3",
  displayName: "File Access Manager",
  description:
    "Configure OS-level filesystem isolation per Hermes profile: discover profiles, " +
    "mark host paths Read/Write, Read Only, or Denied, and enforce them with Docker " +
    "bind mounts. Writes only to the profiles you select — never the router by accident.",
  author: "Ordillect",
  categories: ["ui"],
  capabilities: [
    "agents.read",
    "plugin.state.read",
    "plugin.state.write",
    "instance.settings.register",
    "ui.page.register",
    "ui.sidebar.register",
    "ui.detailTab.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "companySettingsPage",
        id: "file-access-manager",
        displayName: "File Access",
        routePath: "file-access",
        exportName: "FileAccessPage",
      },
      {
        type: "sidebar",
        id: "file-access-nav",
        displayName: "File Access",
        exportName: "FileAccessNavItem",
      },
      // Deliberately NO `routeSidebar` companion. On mobile the host renders
      // `ce ? ae : <AppSidebar/>` — a plugin routeSidebar *replaces* the app
      // nav in the drawer rather than sitting beside it, so declaring one costs
      // the user their Dashboard/Work/Company menu for as long as they are on
      // this route. The agent picker lives in the page instead.
      {
        type: "page",
        id: "file-access-page",
        displayName: "File Access",
        routePath: PAGE_ROUTE,
        exportName: "FileAccessRoutePage",
      },
      // Declared against the documented contract (the SDK lists `agent` as a
      // supported detailTab entity type) but inert today: the host UI never
      // queries detailTab slots for entityType "agent". Left in place so the
      // tab appears with no plugin change once that mount lands upstream.
      {
        type: "detailTab",
        id: "agent-file-access",
        displayName: "File Access",
        entityTypes: ["agent"],
        exportName: "AgentFileAccessTab",
      },
    ],
  },
};

export default manifest;
