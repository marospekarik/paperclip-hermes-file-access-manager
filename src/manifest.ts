import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "ordillect.file-access-manager",
  apiVersion: 1,
  version: "0.4.2",
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
