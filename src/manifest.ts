import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "ordillect.file-access-manager",
  apiVersion: 1,
  version: "0.2.0",
  displayName: "File Access Manager",
  description:
    "Manage the Hermes write sandbox (HERMES_WRITE_SAFE_ROOT) per agent from Paperclip.",
  author: "Ordillect",
  categories: ["ui"],
  capabilities: [
    "agents.read",
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
