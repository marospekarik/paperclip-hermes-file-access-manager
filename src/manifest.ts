import type {
  PluginManifest,
  PluginUiSlotDeclaration,
} from "../paperclip-types.js";

export const manifest: PluginManifest = {
  id: "ordillect.file-access-manager",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "File Access Manager",
  description:
    "Manage Hermes file_access permissions (R / RW / Denied) per agent from a visual UI.",
  author: "Ordillect",
  categories: ["ui"],
  minimumHostVersion: "2026.609.0",
  capabilities: [
    "agents.read",
    "ui.page.register",
    "ui.detailTab.register",
    "plugin.state.read",
    "plugin.state.write",
    "api.routes.register",
  ],
  entrypoints: {
    worker: "dist/worker.js",
    ui: "dist/ui/index.js",
  },
  ui: {
    slots: [
      {
        type: "companySettingsPage",
        id: "file-access-manager",
        displayName: "File Access",
        routePath: "file-access",
        exportName: "FileAccessPage",
      } as PluginUiSlotDeclaration,
      {
        type: "detailTab",
        id: "agent-file-access",
        displayName: "File Access",
        entityTypes: ["agent"],
        exportName: "AgentFileAccessTab",
      } as PluginUiSlotDeclaration,
    ],
  },
  apiRoutes: [
    {
      routeKey: "getAgentFileAccess",
      method: "GET",
      path: "/agents/:agentId/file-access",
      auth: "board",
      capability: "api.routes.register",
    },
    {
      routeKey: "setAgentFileAccess",
      method: "POST",
      path: "/agents/:agentId/file-access",
      auth: "board",
      capability: "api.routes.register",
    },
    {
      routeKey: "scanPath",
      method: "GET",
      path: "/scan",
      auth: "board",
      capability: "api.routes.register",
    },
  ],
};

export default manifest;
