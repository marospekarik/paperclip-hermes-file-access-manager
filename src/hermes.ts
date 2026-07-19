// Hermes-specific resolution helpers: which profile ($HERMES_HOME) an agent
// uses and whether it runs on Hermes at all. The filesystem-isolation logic
// itself lives in docker.ts / env-config.ts, which are Hermes-agnostic.

import * as os from "node:os";
import * as path from "node:path";

/**
 * The main/router Hermes root. Defaults to `~/.hermes`; `FAM_HERMES_ROOT`
 * overrides it (used by tests to point discovery at a temp tree, and available
 * for non-standard installs). Specialized profiles live under `<root>/profiles`.
 */
export function defaultHermesHome(): string {
  const override = process.env.FAM_HERMES_ROOT;
  if (override && override.trim().length > 0) return override.trim();
  return path.join(os.homedir(), ".hermes");
}

/**
 * Resolve the Hermes home for a Paperclip agent. The hermes-paperclip-adapter
 * passes per-agent env through `adapterConfig.env`; multi-profile setups set
 * HERMES_HOME there. Agents without it use the default ~/.hermes.
 */
export function resolveHermesHome(
  adapterConfig: Record<string, unknown> | null | undefined,
): string {
  const env = adapterConfig?.env;
  if (env && typeof env === "object") {
    const home = (env as Record<string, unknown>).HERMES_HOME;
    if (typeof home === "string" && home.trim().length > 0) {
      return home.trim();
    }
  }
  return defaultHermesHome();
}

export function isHermesAdapter(adapterType: string | undefined): boolean {
  return typeof adapterType === "string" && adapterType.includes("hermes");
}

/**
 * Map a Hermes agent to the discovered profile it actually runs on, by matching
 * the agent's resolved HERMES_HOME against each profile's home. Returns the
 * profile name, or null when nothing matches (e.g. the agent points at a home
 * that is not a discovered profile). Callers must NOT silently fall back to the
 * main profile — surfacing "unmatched" is what keeps configuration from leaking
 * into the router/default profile by accident.
 */
export function resolveProfileName(
  adapterConfig: Record<string, unknown> | null | undefined,
  profiles: { name: string; hermesHome: string }[],
): string | null {
  const home = path.resolve(resolveHermesHome(adapterConfig));
  const match = profiles.find((p) => path.resolve(p.hermesHome) === home);
  return match ? match.name : null;
}
