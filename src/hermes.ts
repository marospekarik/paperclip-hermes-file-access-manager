// Pure logic for managing HERMES_WRITE_SAFE_ROOT in a Hermes profile's .env.
//
// Hermes 0.6.0 enforces exactly two filesystem write controls
// (agent/file_safety.py): a hardcoded protected-path list, and the
// HERMES_WRITE_SAFE_ROOT env var — os.pathsep-separated directory roots that
// write_file/patch operations must stay inside. Reads are unrestricted.
// There is no `file_access:` config.yaml block; this module manages the env
// var, which Hermes loads from `$HERMES_HOME/.env` at process start.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

export const ENV_KEY = "HERMES_WRITE_SAFE_ROOT";

// Mirrors hermes-agent's build_write_denied_paths / protected credential
// stores. Informational for the UI — Hermes enforces these regardless of
// HERMES_WRITE_SAFE_ROOT.
export const PROTECTED_PATHS: readonly string[] = [
  "~/.ssh/",
  "~/.aws/",
  "~/.kube/",
  "~/.netrc",
  "/etc/sudoers",
  "$HERMES_HOME/auth.json",
  "$HERMES_HOME/.env",
  ".env / .env.local / .env.production / .envrc (any project)",
];

const ENV_LINE = new RegExp(`^(?:export\\s+)?${ENV_KEY}=(.*)$`);

export function defaultHermesHome(): string {
  return path.join(os.homedir(), ".hermes");
}

export function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/** Validate one write root. Returns an error message or null if valid. */
export function validateRoot(root: string): string | null {
  const trimmed = root.trim();
  if (trimmed.length === 0) return "Path is empty";
  if (trimmed.includes("\n") || trimmed.includes("\r")) {
    return "Path must not contain newlines";
  }
  if (trimmed.includes(":")) {
    return "Path must not contain ':' (it is the Hermes root separator)";
  }
  // The value is written unquoted into .env; these characters would change
  // how python-dotenv parses the line.
  if (/[\s#"'`\\]/.test(trimmed)) {
    return "Path must not contain whitespace, quotes, backslashes, or '#'";
  }
  if (!trimmed.startsWith("/") && trimmed !== "~" && !trimmed.startsWith("~/")) {
    return "Path must be absolute or start with ~/";
  }
  return null;
}

export function parseRoots(envText: string): string[] {
  for (const line of envText.split("\n")) {
    const match = ENV_LINE.exec(line.replace(/\r$/, ""));
    if (match) {
      let value = match[1].trim();
      // python-dotenv accepts quoted values; unwrap a matched pair.
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1);
      }
      const roots = value
        .split(":")
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      return [...new Set(roots)];
    }
  }
  return [];
}

/**
 * Return `envText` with the HERMES_WRITE_SAFE_ROOT line replaced, appended,
 * or removed (when `roots` is empty). Every other line passes through
 * byte-identically — .env holds secrets and this function must never
 * reformat them.
 */
export function upsertRootsLine(envText: string, roots: string[]): string {
  // CRLF-safe: detect the file's EOL, process on bare lines, restore on join.
  const crlf = envText.includes("\r\n");
  const eol = crlf ? "\r\n" : "\n";
  const normalized = crlf ? envText.replaceAll("\r\n", "\n") : envText;

  const newLine = roots.length > 0 ? `${ENV_KEY}=${roots.join(":")}` : null;
  const lines = normalized.length > 0 ? normalized.split("\n") : [];
  const result: string[] = [];
  let replaced = false;
  for (const line of lines) {
    if (ENV_LINE.test(line)) {
      if (newLine !== null && !replaced) result.push(newLine);
      replaced = true;
      continue;
    }
    result.push(line);
  }
  if (!replaced && newLine !== null) {
    while (result.length > 0 && result[result.length - 1] === "") result.pop();
    result.push(newLine);
    result.push("");
  }
  // Files that end without a newline get one — never alters a value, keeps
  // dotenv parsers happy.
  if (result.length > 0 && result[result.length - 1] !== "") result.push("");
  return result.join(eol);
}

export async function readRoots(hermesHome: string): Promise<string[]> {
  const envPath = path.join(expandHome(hermesHome), ".env");
  try {
    return parseRoots(await fs.readFile(envPath, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export async function writeRoots(
  hermesHome: string,
  rawRoots: string[],
): Promise<void> {
  const roots = rawRoots.map((r) => r.trim());
  for (const root of roots) {
    const error = validateRoot(root);
    if (error) throw new Error(`Invalid write root "${root}": ${error}`);
  }
  const home = expandHome(hermesHome);
  // Defense-in-depth: this is the only path where the plugin writes to a
  // location taken from agent config. Hermes homes live under the user's
  // home directory; refuse anything outside it (tmpdir allowed for tests).
  const resolved = path.resolve(home);
  const allowedRoots = [os.homedir(), os.tmpdir()];
  if (!allowedRoots.some((r) => resolved.startsWith(r + path.sep))) {
    throw new Error(`Refusing to write outside ${allowedRoots.join(", ")}: ${home}`);
  }
  const envPath = path.join(home, ".env");
  let current = "";
  try {
    current = await fs.readFile(envPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const next = upsertRootsLine(current, roots);
  await fs.mkdir(home, { recursive: true });
  const tmpPath = path.join(home, `.env.tmp-${crypto.randomUUID()}`);
  await fs.writeFile(tmpPath, next, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmpPath, envPath);
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
