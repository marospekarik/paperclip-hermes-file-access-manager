// Hermes profile discovery. A Hermes install keeps the main/router profile at
// $HERMES_ROOT (default ~/.hermes) and every specialized profile as an
// independent HERMES_HOME under $HERMES_ROOT/profiles/<name>. This module scans
// that layout at runtime so the UI reflects exactly what is on disk — profiles
// added or removed on the host appear/disappear with no plugin change.
//
// Each profile is a fully independent HERMES_HOME (its own config.yaml + .env).
// Writing the Docker backend config to a profile therefore only ever touches
// that profile; the main/router profile is never modified unless the user
// explicitly selects it (name === MAIN_PROFILE_NAME).

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { defaultHermesHome } from "./hermes.js";

/** Sentinel name for the main/router profile ($HERMES_ROOT itself). */
export const MAIN_PROFILE_NAME = "main";

export interface HermesProfile {
  /** "main" for the router/default profile, otherwise the directory name. */
  name: string;
  /** Absolute HERMES_HOME for this profile. */
  hermesHome: string;
  /** True only for the main/router profile at $HERMES_ROOT. */
  isMain: boolean;
}

/** Profile names must be a single safe path segment (no traversal, no slashes). */
export function isValidProfileName(name: string): boolean {
  if (name === MAIN_PROFILE_NAME) return true;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && name !== "." && name !== "..";
}

/**
 * A directory is treated as a HERMES_HOME when it carries at least one of the
 * files Hermes actually reads (`config.yaml` or `.env`). This filters out stray
 * directories under `profiles/` that are not real profiles.
 */
async function looksLikeHermesHome(dir: string): Promise<boolean> {
  for (const marker of ["config.yaml", ".env"]) {
    try {
      await fs.stat(path.join(dir, marker));
      return true;
    } catch {
      // missing marker — keep checking
    }
  }
  return false;
}

/**
 * Resolve a profile name to its HERMES_HOME, rejecting anything that would
 * escape the profiles directory. `MAIN_PROFILE_NAME` maps to the root itself.
 */
export function profileHome(name: string, hermesRoot: string = defaultHermesHome()): string {
  if (name === MAIN_PROFILE_NAME) return hermesRoot;
  if (!isValidProfileName(name)) {
    throw new Error(`Invalid profile name: ${name}`);
  }
  return path.join(hermesRoot, "profiles", name);
}

/**
 * Discover every Hermes profile on the host: the main/router profile at
 * `hermesRoot`, then each valid HERMES_HOME under `hermesRoot/profiles`,
 * sorted with main first and the rest alphabetically. Missing directories
 * yield an empty result rather than throwing.
 */
export async function discoverProfiles(
  hermesRoot: string = defaultHermesHome(),
): Promise<HermesProfile[]> {
  const profiles: HermesProfile[] = [];

  if (await looksLikeHermesHome(hermesRoot)) {
    profiles.push({ name: MAIN_PROFILE_NAME, hermesHome: hermesRoot, isMain: true });
  }

  const profilesDir = path.join(hermesRoot, "profiles");
  let names: string[] = [];
  try {
    const entries = await fs.readdir(profilesDir, { withFileTypes: true });
    names = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((n) => isValidProfileName(n))
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  } catch {
    // no profiles/ directory — main-only install
  }

  for (const name of names) {
    const home = path.join(profilesDir, name);
    if (await looksLikeHermesHome(home)) {
      profiles.push({ name, hermesHome: home, isMain: false });
    }
  }

  return profiles;
}
