// Atomic writers for the two surfaces Hermes actually reads for the Docker
// terminal backend:
//
//   1. `$HERMES_HOME/.env` — the runtime-authoritative surface.
//      `tools/terminal_tool.py` reads TERMINAL_ENV / TERMINAL_DOCKER_VOLUMES /
//      TERMINAL_DOCKER_RUN_AS_HOST_USER from os.environ, and explicit .env
//      values win over the config bridge (_ensure_terminal_env_bridged).
//
//   2. `$HERMES_HOME/config.yaml` `terminal.*` — the human-facing surface that
//      `hermes status`/`hermes config` show and that launchers bridge into env
//      at agent start.
//
// Writing both mirrors what `hermes config set terminal.*` does
// (hermes_cli/config.py:8442 config.yaml + :8448 .env). Every other line in
// either file (API keys, bot tokens, unrelated config) is preserved
// byte-for-byte, and no file contents are ever returned to the UI or logged.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { parseDocument } from "yaml";
import { expandHome } from "./docker.js";

export const TERMINAL_ENV_KEYS = {
  backend: "TERMINAL_ENV",
  volumes: "TERMINAL_DOCKER_VOLUMES",
  runAsHostUser: "TERMINAL_DOCKER_RUN_AS_HOST_USER",
} as const;

/**
 * Mirror hermes_cli.config._quote_env_value: quote only when the value has
 * dotenv-special characters (#, ", ') or surrounding whitespace, escaping `\`
 * and `"`. A JSON array value always contains `"`, so it is always quoted.
 */
export function quoteEnvValue(value: string): string {
  if (value === "") return value;
  const needsQuoting =
    value.includes("#") ||
    value.includes('"') ||
    value.includes("'") ||
    value !== value.trim();
  if (!needsQuoting) return value;
  const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `"${escaped}"`;
}

/** Inverse of quoteEnvValue — used for round-trip tests and readback. */
export function unquoteEnvValue(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\");
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1);
  }
  return v;
}

function keyLineRegex(key: string): RegExp {
  return new RegExp(`^(?:export\\s+)?${key}=`);
}

/**
 * Upsert several env keys into `.env` text. `null` removes a key. Every
 * unrelated line passes through byte-identically; CRLF files stay CRLF. New
 * keys are appended (in the given order) with a single trailing newline.
 */
export function upsertEnvVars(
  envText: string,
  vars: Record<string, string | null>,
): string {
  const crlf = envText.includes("\r\n");
  const eol = crlf ? "\r\n" : "\n";
  const normalized = crlf ? envText.replaceAll("\r\n", "\n") : envText;

  const lines = normalized.length > 0 ? normalized.split("\n") : [];
  const result: string[] = [];
  const handled = new Set<string>();

  for (const line of lines) {
    const key = Object.keys(vars).find((k) => keyLineRegex(k).test(line));
    if (key) {
      handled.add(key);
      const val = vars[key];
      if (val !== null) result.push(`${key}=${quoteEnvValue(val)}`);
      continue; // a removed key drops the line entirely
    }
    result.push(line);
  }

  // Append any keys that weren't already present (preserve insertion order).
  const toAppend = Object.keys(vars).filter(
    (k) => !handled.has(k) && vars[k] !== null,
  );
  if (toAppend.length > 0) {
    while (result.length > 0 && result[result.length - 1] === "") result.pop();
    for (const k of toAppend) result.push(`${k}=${quoteEnvValue(vars[k] as string)}`);
  }
  if (result.length > 0 && result[result.length - 1] !== "") result.push("");
  return result.join(eol);
}

/**
 * Set `terminal.backend`, `terminal.docker_volumes`, and
 * `terminal.docker_run_as_host_user` in config.yaml text, preserving all other
 * keys, ordering, and comments (yaml Document API). Creates the `terminal:`
 * map if absent.
 */
export function updateTerminalConfigYaml(
  yamlText: string,
  terminal: { backend: string; docker_volumes: string[]; docker_run_as_host_user: boolean },
): string {
  const doc = parseDocument(yamlText.length > 0 ? yamlText : "{}");
  doc.setIn(["terminal", "backend"], terminal.backend);
  doc.setIn(["terminal", "docker_volumes"], terminal.docker_volumes);
  doc.setIn(["terminal", "docker_run_as_host_user"], terminal.docker_run_as_host_user);
  return doc.toString();
}

// --- atomic filesystem plumbing ------------------------------------------

/**
 * A write target is allowed when it is the home directory, the OS temp dir, or
 * one of the explicitly-permitted roots (the Hermes home being written), or a
 * descendant of any of those. This is defense-in-depth against a bug that
 * computes a wild path — NOT a policy that Hermes must live under $HOME. A
 * system-wide install (`/opt/hermes`, `/srv/...`) or a `FAM_HERMES_ROOT` outside
 * $HOME is legitimate and passes precisely because the caller vouches for it via
 * `extraRoots`.
 */
export function isWritableLocation(target: string, extraRoots: string[] = []): boolean {
  const resolved = path.resolve(target);
  const allowed = [os.homedir(), os.tmpdir(), ...extraRoots].map((r) => path.resolve(r));
  return allowed.some((r) => resolved === r || resolved.startsWith(r + path.sep));
}

function assertWritableLocation(target: string, extraRoots: string[] = []): void {
  if (!isWritableLocation(target, extraRoots)) {
    const allowed = [os.homedir(), os.tmpdir(), ...extraRoots];
    throw new Error(`Refusing to write outside ${allowed.join(", ")}: ${target}`);
  }
}

async function atomicWrite(
  filePath: string,
  content: string,
  mode = 0o600,
  allowedRoots: string[] = [],
): Promise<void> {
  const dir = path.dirname(filePath);
  assertWritableLocation(dir, allowedRoots);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${crypto.randomUUID()}`);
  await fs.writeFile(tmp, content, { encoding: "utf8", mode });
  await fs.rename(tmp, filePath);
}

async function readOrEmpty(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

/** Atomically upsert env keys in `$HERMES_HOME/.env`, preserving all else. */
export async function writeEnvVars(
  hermesHome: string,
  vars: Record<string, string | null>,
): Promise<void> {
  const home = expandHome(hermesHome);
  const envPath = path.join(home, ".env");
  const next = upsertEnvVars(await readOrEmpty(envPath), vars);
  await atomicWrite(envPath, next, 0o600, [home]);
}

/** Atomically update `terminal.*` in `$HERMES_HOME/config.yaml`, preserving comments. */
export async function writeTerminalConfigYaml(
  hermesHome: string,
  terminal: { backend: string; docker_volumes: string[]; docker_run_as_host_user: boolean },
): Promise<void> {
  const home = expandHome(hermesHome);
  const cfgPath = path.join(home, "config.yaml");
  const next = updateTerminalConfigYaml(await readOrEmpty(cfgPath), terminal);
  await atomicWrite(cfgPath, next, 0o600, [home]);
}

/**
 * Read one env key's (unquoted) value from `$HERMES_HOME/.env`, or null when the
 * file or key is absent. Used to discover the profile's `HERMES_DOCKER_BINARY`
 * so the runtime-apply step recreates the container with the same runtime Hermes
 * uses (docker vs podman). Never returns file contents beyond the requested key.
 */
export async function readEnvVar(hermesHome: string, key: string): Promise<string | null> {
  const home = expandHome(hermesHome);
  const text = await readOrEmpty(path.join(home, ".env"));
  const lineRe = keyLineRegex(key);
  for (const line of text.replaceAll("\r\n", "\n").split("\n")) {
    if (lineRe.test(line)) {
      return unquoteEnvValue(line.slice(line.indexOf("=") + 1));
    }
  }
  return null;
}
