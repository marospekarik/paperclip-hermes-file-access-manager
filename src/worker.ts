import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import {
  type AgentAccess,
  type Assignment,
  type Mode,
  generateDockerVolumes,
  normalizeHostPath,
  realpathIfExists,
  validatePath,
} from "./docker.js";
import {
  TERMINAL_ENV_KEYS,
  readEnvVar,
  readTerminalBackend,
  writeEnvVars,
  writeTerminalConfigYaml,
} from "./env-config.js";
import { defaultRoots, listDir } from "./fs-tree.js";
import { isHermesAdapter, resolveProfileName } from "./hermes.js";
import { type ApplyStep, applyRuntime, overallState, resolveDockerBinary } from "./apply.js";
import {
  type HermesProfile,
  MAIN_PROFILE_NAME,
  discoverProfiles,
} from "./profiles.js";

const MASK_DIR_NAME = ".file-access-deny-mask";

const ENFORCEMENT_NOTE =
  "Access is enforced by Docker, not the application: each path is bind-mounted " +
  "read-write, read-only, or not mounted at all. Saving switches this Hermes " +
  "profile's terminal backend to Docker and applies the mounts when an agent on " +
  "this profile next starts. Hermes routes terminal, read_file, write_file, and " +
  "execute_code through this container, so a profile with nothing granted leaves " +
  "those tools unable to reach the host filesystem — grant the paths the agent needs.";

const VALID_MODES = new Set<Mode>(["rw", "ro", "denied"]);

export interface ProfileSummary extends HermesProfile {
  /**
   * Effective terminal backend on disk ("docker" = isolated by this plugin,
   * "local"/other/null = not yet isolated). Drives the profile-picker status
   * badge so a user can see which profiles are sandboxed before configuring.
   */
  backend: string | null;
}

export interface ProfileAccessResponse {
  profile: string;
  isMain: boolean;
  hermesHome: string;
  homeDir: string;
  maskDir: string;
  roots: string[];
  assignments: Assignment[];
  /** Preview of the docker_volumes that these assignments generate. */
  volumesPreview: string[];
  /** Effective backend on disk — lets the editor phrase Save as "Enable Docker isolation". */
  backend: string | null;
  note: string;
}

export interface ProfilesResponse {
  homeDir: string;
  profiles: ProfileSummary[];
}

export interface ProfileApplyResult {
  profile: string;
  hermesHome: string;
  volumes: string[];
  steps: ApplyStep[];
  state: "ready" | "needs-attention";
}

export interface SetProfileAccessResponse {
  profiles: ProfileApplyResult[];
}

interface ProfileParams {
  profile?: unknown;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function stateKeyFor(profileName: string): string {
  return `profile-access:${profileName}`;
}

/** Coerce arbitrary stored/param JSON into a validated Assignment list. */
function parseAssignments(raw: unknown): Assignment[] {
  if (!Array.isArray(raw)) return [];
  const out: Assignment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const p = (item as Assignment).path;
    const m = (item as Assignment).mode;
    if (typeof p === "string" && VALID_MODES.has(m as Mode)) {
      out.push({ path: p, mode: m as Mode });
    }
  }
  return out;
}

function parseRoots(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is string => typeof r === "string" && r.length > 0);
}

function parseProfileNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (typeof r === "string" && r.length > 0) seen.add(r);
  }
  return [...seen];
}

const plugin = definePlugin({
  async setup(ctx) {
    const homeDir = os.homedir();

    function maskDirFor(hermesHome: string): string {
      return path.join(hermesHome, MASK_DIR_NAME);
    }

    async function readStored(profileName: string): Promise<AgentAccess> {
      const stored = await ctx.state.get({
        scopeKind: "instance" as const,
        scopeId: profileName,
        stateKey: stateKeyFor(profileName),
      });
      const s = (stored ?? {}) as Partial<AgentAccess>;
      const roots = parseRoots(s.roots);
      return {
        roots: roots.length > 0 ? roots : defaultRoots(homeDir),
        assignments: parseAssignments(s.assignments),
      };
    }

    /** Resolve a profile by name, requiring it to exist on disk. */
    async function requireProfile(name: string): Promise<HermesProfile> {
      const profiles = await discoverProfiles();
      const found = profiles.find((p) => p.name === name);
      if (!found) throw new Error(`Unknown Hermes profile: ${name}`);
      return found;
    }

    // Discover every Hermes profile on the host at request time so the UI stays
    // in sync with the filesystem (profiles added/removed need no plugin change).
    ctx.data.register("hermes-profiles", async (): Promise<ProfilesResponse> => {
      const discovered = await discoverProfiles();
      const profiles: ProfileSummary[] = await Promise.all(
        discovered.map(async (p) => ({
          ...p,
          backend: await readTerminalBackend(p.hermesHome),
        })),
      );
      return { homeDir, profiles };
    });

    // Map a Paperclip agent to the profile it runs on (for the agent detail tab).
    // Never falls back to main: an unmatched agent returns profile: null so the
    // UI can warn instead of silently configuring the router/default profile.
    ctx.data.register("agent-profile", async (params) => {
      const p = params as { companyId?: unknown; agentId?: unknown };
      const companyId = requireString(p.companyId, "companyId");
      const agentId = requireString(p.agentId, "agentId");
      const agent = await ctx.agents.get(agentId, companyId);
      if (!agent) throw new Error(`Agent not found: ${agentId}`);
      const configurable = isHermesAdapter(agent.adapterType);
      const profiles = await discoverProfiles();
      const profile = configurable
        ? resolveProfileName(agent.adapterConfig, profiles)
        : null;
      return {
        agentId: agent.id,
        agentName: agent.name,
        adapterType: agent.adapterType,
        configurable,
        profile,
        isMain: profile === MAIN_PROFILE_NAME,
      };
    });

    // One directory level for the lazy tree. Confined to the agent's roots.
    ctx.data.register("list-dir", async (params) => {
      const p = requireString((params as { path?: unknown }).path, "path");
      const roots = parseRoots((params as { roots?: unknown }).roots);
      const effectiveRoots = roots.length > 0 ? roots : defaultRoots(homeDir);
      const entries = await listDir(p, effectiveRoots, homeDir);
      return { path: normalizeHostPath(p, homeDir), entries };
    });

    // Current access model for one profile + a preview of the generated mounts.
    ctx.data.register("profile-access", async (params): Promise<ProfileAccessResponse> => {
      const name = requireString((params as ProfileParams).profile, "profile");
      const profile = await requireProfile(name);
      const maskDir = maskDirFor(profile.hermesHome);
      const stored = await readStored(name);
      return {
        profile: profile.name,
        isMain: profile.isMain,
        hermesHome: profile.hermesHome,
        homeDir,
        maskDir,
        roots: stored.roots,
        assignments: stored.assignments,
        volumesPreview: generateDockerVolumes(stored.assignments, { maskDir }),
        backend: await readTerminalBackend(profile.hermesHome),
        note: ENFORCEMENT_NOTE,
      };
    });

    // Persist assignments and write the Docker terminal backend to EACH selected
    // profile — and only those. The main/router profile is touched only when its
    // name ("main") is explicitly among the selected profiles.
    ctx.actions.register("set-profile-access", async (params) => {
      const p = params as { profiles?: unknown; roots?: unknown; assignments?: unknown };
      const requested = parseProfileNames(p.profiles);
      if (requested.length === 0) {
        throw new Error("Select at least one profile to configure");
      }

      // Resolve every requested profile up-front; reject unknown names before
      // writing anything so a partial/typo'd request never lands on disk.
      const available = await discoverProfiles();
      const targets: HermesProfile[] = [];
      for (const name of requested) {
        const found = available.find((a) => a.name === name);
        if (!found) throw new Error(`Unknown Hermes profile: ${name}`);
        targets.push(found);
      }

      const roots = parseRoots(p.roots);
      const rawAssignments = parseAssignments(p.assignments);

      // Normalize + realpath every path, validate, and require rw/ro sources to
      // exist (Docker would otherwise auto-create a root-owned mount source).
      const assignments: Assignment[] = [];
      for (const a of rawAssignments) {
        const err = validatePath(a.path, homeDir);
        if (err) throw new Error(`Invalid path "${a.path}": ${err}`);
        const real = await realpathIfExists(normalizeHostPath(a.path, homeDir));
        if (a.mode === "rw" || a.mode === "ro") {
          try {
            await fs.stat(real);
          } catch {
            throw new Error(`Cannot grant access to a missing path: ${real}`);
          }
        }
        assignments.push({ path: real, mode: a.mode });
      }

      const model: AgentAccess = {
        roots: roots.length > 0 ? roots : defaultRoots(homeDir),
        assignments,
      };

      const results: ProfileApplyResult[] = [];
      for (const target of targets) {
        const maskDir = maskDirFor(target.hermesHome);
        // Ensure the empty read-only mask directory exists before any denied
        // path references it as a bind-mount source.
        await fs.mkdir(maskDir, { recursive: true });
        await fs.chmod(maskDir, 0o555).catch(() => {});

        const volumes = generateDockerVolumes(assignments, { maskDir });

        await ctx.state.set(
          {
            scopeKind: "instance" as const,
            scopeId: target.name,
            stateKey: stateKeyFor(target.name),
          },
          model,
        );

        await writeEnvVars(target.hermesHome, {
          [TERMINAL_ENV_KEYS.backend]: "docker",
          [TERMINAL_ENV_KEYS.volumes]: JSON.stringify(volumes),
          [TERMINAL_ENV_KEYS.runAsHostUser]: "true",
        });
        await writeTerminalConfigYaml(target.hermesHome, {
          backend: "docker",
          docker_volumes: volumes,
          docker_run_as_host_user: true,
        });

        ctx.logger.info("Updated Docker file-access mounts", {
          profile: target.name,
          hermesHome: target.hermesHome,
          assignmentCount: assignments.length,
          mountCount: volumes.length,
        });

        // Config on disk is not enough: the running gateway holds the old env,
        // and the Docker backend reuses its container by label without checking
        // mounts. Recreate the container + restart the gateway so the change
        // takes effect, and report each step's status.
        const configStep: ApplyStep = {
          key: "config",
          label: "Write profile config",
          status: "ok",
          detail: `${volumes.length} mount(s) written to .env + config.yaml.`,
        };
        // FAM_SKIP_RUNTIME_APPLY=1 disables the disruptive container-recreate +
        // gateway-restart (used by tests, and an escape hatch for anyone who
        // prefers to restart manually). Config is still written either way.
        const runtimeSteps =
          process.env.FAM_SKIP_RUNTIME_APPLY === "1"
            ? [
                {
                  key: "runtime",
                  label: "Apply at runtime",
                  status: "skipped" as const,
                  detail:
                    "Auto-apply disabled — remove the profile's Docker container and restart its gateway to take effect.",
                },
              ]
            : await applyRuntime(
                target,
                undefined,
                {},
                // Use the same container runtime Hermes will (docker vs podman),
                // read from this profile's own .env, so recreate targets the
                // right containers instead of silently skipping on a Podman host.
                resolveDockerBinary(
                  await readEnvVar(target.hermesHome, "HERMES_DOCKER_BINARY"),
                ),
              );
        const steps = [configStep, ...runtimeSteps];
        const state = overallState(steps);

        ctx.logger.info("Applied file-access runtime", {
          profile: target.name,
          state,
          steps: steps.map((s) => `${s.key}:${s.status}`),
        });

        results.push({ profile: target.name, hermesHome: target.hermesHome, volumes, steps, state });
      }

      return { profiles: results };
    });
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
