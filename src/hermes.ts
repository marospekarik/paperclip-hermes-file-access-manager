// Hermes-specific resolution helpers: which profile ($HERMES_HOME) an agent
// uses and whether it runs on Hermes at all. The filesystem-isolation logic
// itself lives in docker.ts / env-config.ts, which are Hermes-agnostic.
//
// The resolution below deliberately mirrors Hermes's OWN precedence chain
// (hermes_cli/main.py `_apply_profile_override`), because that function is what
// actually decides HERMES_HOME at run time. Getting the order wrong here means
// the plugin sandboxes a different profile than the agent runs on — a silent,
// security-relevant miss. Hermes resolves, in order:
//
//   1. `-p` / `--profile <name>` / `--profile=<name>` in argv   (HIGHEST)
//   2. an inherited HERMES_HOME env var, but ONLY when it is already
//      profile-shaped (its parent directory is named `profiles`)
//   3. the `active_profile` file in the hermes root
//   4. the hermes root itself                                   (LOWEST)
//
// Step 1 beats step 2: `hermes -p maker` overrides HERMES_HOME. Reading only
// `adapterConfig.env.HERMES_HOME` — the *lowest*-priority signal — is why every
// agent used to resolve to the router/default profile.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Valid Hermes profile id, copied verbatim from `hermes_cli/profiles.py`
 * (`_PROFILE_ID_RE`). Lowercase only — a `-p Maker` that Hermes would reject
 * must not resolve here either.
 */
export const HERMES_PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Hermes's alias for the root HERMES_HOME. This plugin calls it "main". */
const HERMES_DEFAULT_PROFILE = "default";

/** Largest `hermesCommand` wrapper script worth reading, in bytes. */
const MAX_WRAPPER_BYTES = 8 * 1024;

/**
 * Adapter types this plugin can isolate. The hermes-paperclip-adapter registers
 * exactly `hermes_local` today; the pattern leaves room for a future sibling
 * (`hermes_remote`, …) while refusing types that merely *contain* the word —
 * `claude_hermes_bridge` and `not_hermes` are not Hermes adapters.
 */
const HERMES_ADAPTER_RE = /^hermes(?:[_-][a-z0-9]+)*$/;

/** Where the resolved HERMES_HOME came from, for display and for diagnostics. */
export type ProfileSource =
  /** `-p`/`--profile` in `adapterConfig.extraArgs`. */
  | "extra-args"
  /** `-p` baked into the `hermesCommand` wrapper/alias script. */
  | "hermes-command"
  /** `adapterConfig.env.HERMES_HOME`, profile-shaped. */
  | "env"
  /** The `active_profile` file in the hermes root. */
  | "active-profile"
  /** Nothing selected a profile — the root HERMES_HOME. */
  | "default";

export interface HermesHomeResolution {
  /** Absolute HERMES_HOME this agent will actually run with. */
  hermesHome: string;
  /** Which signal decided it. */
  source: ProfileSource;
  /**
   * `adapterConfig.profile`, if present. Paperclip's agent form writes this
   * field, but the hermes adapter never reads it — it only passes `hermesCommand`,
   * `extraArgs` and `env` through. So it is a *declared* profile, not an
   * effective one, and is reported separately rather than trusted.
   */
  declaredProfile: string | null;
}

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

/** Map a Hermes profile id to its HERMES_HOME. `default` means the root itself. */
function homeForProfileId(name: string, hermesRoot: string): string | null {
  const canon = name.trim().toLowerCase();
  if (canon === HERMES_DEFAULT_PROFILE) return hermesRoot;
  if (!HERMES_PROFILE_ID_RE.test(canon)) return null;
  return path.join(hermesRoot, "profiles", canon);
}

/**
 * Scan an argv list for Hermes's profile flag, mirroring `_apply_profile_override`
 * step 1: stop at `--`, accept `-p <name>`, `--profile <name>` and
 * `--profile=<name>`, and ignore values that are not valid profile ids (step 1b).
 */
export function profileFlagFromArgv(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") break;
    if ((arg === "-p" || arg === "--profile") && i + 1 < argv.length) {
      const value = argv[i + 1];
      return HERMES_PROFILE_ID_RE.test(value) ? value : null;
    }
    if (arg.startsWith("--profile=")) {
      const value = arg.slice("--profile=".length);
      return HERMES_PROFILE_ID_RE.test(value) ? value : null;
    }
  }
  return null;
}

/**
 * The profile a `hermesCommand` selects.
 *
 * `hermes profile alias <name>` installs a wrapper script — the shape actually
 * found on this host is:
 *
 *     #!/bin/sh
 *     exec /home/user/.local/bin/hermes -p maker "$@"
 *
 * so the profile lives inside the wrapper, not in adapterConfig. Handles both
 * an inline command string with arguments and a path to such a wrapper. Any
 * read failure yields null — this is a best-effort hint, never a hard error.
 */
export async function profileFromHermesCommand(command: string): Promise<string | null> {
  const trimmed = command.trim();
  if (trimmed.length === 0) return null;

  // Inline form: "hermes -p maker". Tokenize the string itself.
  if (/\s/.test(trimmed)) {
    const inline = profileFlagFromArgv(tokenize(trimmed));
    if (inline) return inline;
  }

  // Wrapper form: a path to a small shell script that execs hermes with -p.
  const file = trimmed.split(/\s+/)[0];
  if (!path.isAbsolute(file)) return null;
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_WRAPPER_BYTES) return null;
    const text = await fs.readFile(file, "utf8");
    for (const line of text.split("\n")) {
      if (!line.includes("hermes")) continue;
      const found = profileFlagFromArgv(tokenize(line));
      if (found) return found;
    }
  } catch {
    // Missing/unreadable/binary wrapper — fall through to the next signal.
  }
  return null;
}

/** Split a shell-ish line into tokens, dropping simple quoting. */
function tokenize(line: string): string[] {
  return (line.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((t) =>
    (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))
      ? t.slice(1, -1)
      : t,
  );
}

/** A HERMES_HOME is "profile-shaped" when its parent directory is named `profiles`. */
function isProfileShaped(home: string): boolean {
  return path.basename(path.dirname(path.resolve(home))) === "profiles";
}

/** The `active_profile` file in the hermes root, or null when unset/unreadable. */
async function readActiveProfile(hermesRoot: string): Promise<string | null> {
  try {
    const name = (await fs.readFile(path.join(hermesRoot, "active_profile"), "utf8")).trim();
    if (!name || name === HERMES_DEFAULT_PROFILE) return null;
    return HERMES_PROFILE_ID_RE.test(name) ? name : null;
  } catch {
    return null;
  }
}

function configString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function configStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Resolve the HERMES_HOME a Paperclip agent will actually run with, following
 * Hermes's own precedence chain (see the module header). Never throws.
 */
export async function resolveHermesHome(
  adapterConfig: Record<string, unknown> | null | undefined,
  hermesRoot: string = defaultHermesHome(),
): Promise<HermesHomeResolution> {
  const config = adapterConfig ?? {};
  const declaredProfile = configString(config.profile);

  // 1. Explicit -p / --profile in extraArgs (highest — beats HERMES_HOME).
  const fromArgs = profileFlagFromArgv(configStringArray(config.extraArgs));
  if (fromArgs) {
    const home = homeForProfileId(fromArgs, hermesRoot);
    if (home) return { hermesHome: home, source: "extra-args", declaredProfile };
  }

  // 2. -p baked into the hermesCommand wrapper — also argv, same priority tier.
  const command = configString(config.hermesCommand);
  if (command) {
    const fromCommand = await profileFromHermesCommand(command);
    if (fromCommand) {
      const home = homeForProfileId(fromCommand, hermesRoot);
      if (home) return { hermesHome: home, source: "hermes-command", declaredProfile };
    }
  }

  // 3. An inherited HERMES_HOME, but only when already profile-shaped — Hermes
  //    ignores a root-shaped one here and falls through to active_profile.
  const env = config.env;
  if (env && typeof env === "object") {
    const home = configString((env as Record<string, unknown>).HERMES_HOME);
    if (home && isProfileShaped(home)) {
      return { hermesHome: home, source: "env", declaredProfile };
    }
    if (home) {
      // Root-shaped HERMES_HOME: Hermes keeps looking, but if nothing else
      // selects a profile this is where it lands, so remember it as the base.
      hermesRoot = home;
    }
  }

  // 4. The sticky active_profile file in the hermes root.
  const active = await readActiveProfile(hermesRoot);
  if (active) {
    const home = homeForProfileId(active, hermesRoot);
    if (home) return { hermesHome: home, source: "active-profile", declaredProfile };
  }

  // 5. Nothing selected a profile — the root HERMES_HOME.
  return { hermesHome: hermesRoot, source: "default", declaredProfile };
}

/**
 * Whether a Paperclip adapter type is one this plugin can isolate. Anchored
 * rather than a substring test so an unrelated adapter that merely mentions
 * Hermes is not offered a Docker terminal backend it does not have.
 */
export function isHermesAdapter(adapterType: string | undefined): boolean {
  return typeof adapterType === "string" && HERMES_ADAPTER_RE.test(adapterType.trim());
}

export interface ResolvedAgentProfile {
  /** Discovered profile name, or null when the resolved home matches none. */
  profile: string | null;
  /** Which signal decided the HERMES_HOME. */
  source: ProfileSource;
  /** The resolved HERMES_HOME itself, useful when `profile` is null. */
  hermesHome: string;
  /** `adapterConfig.profile` — declared in Paperclip but not read by the adapter. */
  declaredProfile: string | null;
  /**
   * True when a declared profile exists and disagrees with the effective one.
   * That combination means the Paperclip form says one thing and the agent runs
   * as another, so the UI warns instead of silently picking a side.
   */
  declaredMismatch: boolean;
}

/**
 * Map a Hermes agent to the discovered profile it actually runs on, by matching
 * its resolved HERMES_HOME against each profile's home. `profile` is null when
 * nothing matches (e.g. the agent points at a home that is not a discovered
 * profile). Callers must NOT silently fall back to the main profile — surfacing
 * "unmatched" is what keeps configuration from leaking into the router/default
 * profile by accident.
 */
export async function resolveAgentProfile(
  adapterConfig: Record<string, unknown> | null | undefined,
  profiles: readonly { name: string; hermesHome: string }[],
  hermesRoot: string = defaultHermesHome(),
): Promise<ResolvedAgentProfile> {
  const { hermesHome, source, declaredProfile } = await resolveHermesHome(
    adapterConfig,
    hermesRoot,
  );
  const resolved = path.resolve(hermesHome);
  const match = profiles.find((p) => path.resolve(p.hermesHome) === resolved);
  const profile = match ? match.name : null;
  return {
    profile,
    source,
    hermesHome: resolved,
    declaredProfile,
    declaredMismatch:
      declaredProfile !== null &&
      profile !== null &&
      declaredProfile.trim().toLowerCase() !== profile.toLowerCase(),
  };
}
