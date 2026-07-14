// Minimal subset of Paperclip plugin runtime types used by this plugin.
// These APIs are provided by the Paperclip host at runtime and never bundled.

export type PluginCategory = "connector" | "workspace" | "automation" | "ui";

export type PluginCapability =
  | "agents.read"
  | "agents.managed"
  | "ui.page.register"
  | "ui.settingsPage.register"
  | "ui.sidebar.register"
  | "ui.detailTab.register"
  | "plugin.state.read"
  | "plugin.state.write"
  | "api.routes.register"
  | "database.namespace.read"
  | "database.namespace.write";

export type PluginUiSlotType =
  | "page"
  | "detailTab"
  | "companySettingsPage"
  | "sidebar"
  | "settingsPage";

export interface PluginUiSlotDeclaration {
  type: PluginUiSlotType;
  id: string;
  displayName: string;
  exportName: string;
  routePath?: string;
  entityTypes?: string[];
}

export interface PluginApiRouteDeclaration {
  routeKey: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  auth: "board" | "agent" | "board-or-agent" | "webhook";
  capability: PluginCapability;
  checkoutPolicy?: "none" | "required-for-agent-in-progress" | "always-for-agent";
}

export interface PluginManifest {
  id: string;
  apiVersion: 1;
  version: string;
  displayName: string;
  description: string;
  author: string;
  categories: PluginCategory[];
  minimumHostVersion?: string;
  capabilities: PluginCapability[];
  entrypoints: {
    worker: string;
    ui?: string;
  };
  apiRoutes?: PluginApiRouteDeclaration[];
  ui?: {
    slots?: PluginUiSlotDeclaration[];
  };
}

export interface PaperclipAgent {
  id: string;
  name: string;
  adapterType?: string;
  adapterConfig?: Record<string, unknown>;
  companyId: string;
}

export interface RouteContext {
  params: Record<string, string>;
  query: Record<string, string>;
  body?: unknown;
  agent?: PaperclipAgent;
}

export interface WorkerApi {
  onRoute: (
    routeKey: string,
    handler: (ctx: RouteContext) => Promise<unknown> | unknown,
  ) => void;
  getAgents: () => Promise<PaperclipAgent[]>;
  readState: <T>(scope: string, key: string, defaultValue?: T) => Promise<T>;
  writeState: <T>(scope: string, key: string, value: T) => Promise<void>;
}

export interface FileAccessConfig {
  allowed_paths: string[];
  read_only_paths: string[];
  denied_paths: string[];
}

export type PermissionState = "R" | "RW" | "D";

export interface AgentFileAccessState {
  profileName: string;
  paths: Record<string, PermissionState>;
  updatedAt: string;
}
