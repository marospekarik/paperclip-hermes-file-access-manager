import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as yaml from "js-yaml";
import type {
  AgentFileAccessState,
  FileAccessConfig,
  PermissionState,
  RouteContext,
  WorkerApi,
} from "./paperclip-types.js";

export interface HermesProfile {
  name: string;
  configPath: string;
}

export function resolveProfilePath(profileName: string): string {
  if (profileName.includes("/") || profileName.includes("\\")) {
    throw new Error("Invalid profile name: path separators not allowed");
  }
  const home = os.homedir();
  return path.join(home, ".hermes", "profiles", profileName, "config.yaml");
}

function fallbackProfileName(agent: { id?: string; name?: string }): string {
  // Paperclip agent names for Ordillect are prefixed with the Hermes profile name
  // e.g. "ord-engineer". If not, use the agent id or name as a last resort.
  const fromName = agent.name?.match(/^(ord-[a-z]+)/)?.[1];
  return fromName || agent.name || agent.id || "default";
}

export function mapPermissionToConfig(
  paths: Record<string, PermissionState>,
): FileAccessConfig {
  const allowed_paths: string[] = [];
  const read_only_paths: string[] = [];
  const denied_paths: string[] = [];
  for (const [p, state] of Object.entries(paths)) {
    if (state === "RW") allowed_paths.push(p);
    else if (state === "R") read_only_paths.push(p);
    else if (state === "D") denied_paths.push(p);
  }
  return { allowed_paths, read_only_paths, denied_paths };
}

export function mapConfigToPermissions(
  config: Partial<FileAccessConfig>,
): Record<string, PermissionState> {
  const out: Record<string, PermissionState> = {};
  for (const p of config.allowed_paths ?? []) out[p] = "RW";
  for (const p of config.read_only_paths ?? []) out[p] = "R";
  for (const p of config.denied_paths ?? []) out[p] = "D";
  return out;
}

export async function readProfileConfig(
  profileName: string,
): Promise<AgentFileAccessState> {
  const configPath = resolveProfilePath(profileName);
  let raw = "";
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return {
        profileName,
        paths: {},
        updatedAt: new Date().toISOString(),
      };
    }
    throw err;
  }
// js-yaml v4.x: load() defaults to safe loading (same as safeLoad in v3).
  const parsed = yaml.load(raw) as Record<string, unknown> | null;
  const fac = (parsed?.file_access ?? {}) as Partial<FileAccessConfig>;
  return {
    profileName,
    paths: mapConfigToPermissions(fac),
    updatedAt: new Date().toISOString(),
  };
}

export async function writeProfileConfig(
  profileName: string,
  paths: Record<string, PermissionState>,
): Promise<AgentFileAccessState> {
  const configPath = resolveProfilePath(profileName);
  let parsed: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(configPath, "utf8");
    // js-yaml v4.x: load() defaults to safe loading (same as safeLoad in v3).
    parsed = (yaml.load(raw) as Record<string, unknown>) || {};
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
  }

  const fac = mapPermissionToConfig(paths);
  parsed.file_access = fac;

  const raw = yaml.dump(parsed, { lineWidth: -1, noRefs: true });
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, raw, "utf8");

  return {
    profileName,
    paths,
    updatedAt: new Date().toISOString(),
  };
}

export async function scanFilesystem(root: string): Promise<string[]> {
  const entries: string[] = [];
  try {
    const dir = await fs.opendir(root);
    for await (const entry of dir) {
      if (entry.name.startsWith(".")) continue;
      entries.push(path.join(root, entry.name));
    }
  } catch (err: any) {
    if (err?.code === "EACCES" || err?.code === "ENOENT") {
      return [];
    }
    throw err;
  }
  return entries.sort();
}

export function createWorker(api: WorkerApi): void {
  api.onRoute("getAgentFileAccess", async (ctx: RouteContext) => {
    const agentId = ctx.params.agentId;
    const agents = await api.getAgents();
    const agent = agents.find((a) => a.id === agentId);
    const profileName =
      (agent?.adapterConfig?.HERMES_PROFILE as string | undefined) ||
      (agent?.adapterConfig?.hermesProfile as string | undefined) ||
      fallbackProfileName(agent ?? { id: agentId });
    return readProfileConfig(profileName);
  });

  api.onRoute("setAgentFileAccess", async (ctx: RouteContext) => {
    const agentId = ctx.params.agentId;
    const body = (ctx.body || {}) as { paths?: Record<string, PermissionState> };
    const agents = await api.getAgents();
    const agent = agents.find((a) => a.id === agentId);
    const profileName =
      (agent?.adapterConfig?.HERMES_PROFILE as string | undefined) ||
      (agent?.adapterConfig?.hermesProfile as string | undefined) ||
      fallbackProfileName(agent ?? { id: agentId });
    const paths = body.paths || {};
    return writeProfileConfig(profileName, paths);
  });

  api.onRoute("scanPath", async (ctx: RouteContext) => {
    const root = ctx.query.root || "/";
    return scanFilesystem(root);
  });
}
