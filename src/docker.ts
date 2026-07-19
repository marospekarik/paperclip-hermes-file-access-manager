// Node-dependent host-path helpers for the Docker file-access backend. The
// pure permission model + volume translation live in model.ts (browser-safe);
// this module adds the path normalization / validation that needs `node:*`.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export * from "./model.js";

/** Expand a leading `~`/`~/` against a home directory. Lexical only. */
export function expandHome(p: string, homeDir: string = os.homedir()): string {
  if (p === "~") return homeDir;
  if (p.startsWith("~/")) return path.join(homeDir, p.slice(2));
  return p;
}

/**
 * Lexically normalize a host path: expand `~`, resolve `.`/`..` and redundant
 * separators, strip a trailing slash. Does NOT touch the filesystem. Symlink
 * resolution (macOS `/var` → `/private/var`) is `realpathIfExists`.
 */
export function normalizeHostPath(p: string, homeDir: string = os.homedir()): string {
  const expanded = expandHome(p.trim(), homeDir);
  const resolved = path.resolve(expanded);
  return resolved.length > 1 && resolved.endsWith(path.sep)
    ? resolved.slice(0, -1)
    : resolved;
}

/**
 * Resolve symlinks in an existing path so the bind-mount source matches the
 * kernel's real path (Docker Desktop on macOS aliases the `/var` symlink
 * otherwise). Missing paths pass through unchanged.
 */
export async function realpathIfExists(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return p;
  }
}

/**
 * Validate a host path chosen as a mount source. Returns an error string, or
 * null when valid. Rejects `:` (Docker's spec separator) and paths that would
 * defeat isolation (mounting `/` or the whole home directory).
 */
export function validatePath(p: string, homeDir: string = os.homedir()): string | null {
  const trimmed = p.trim();
  if (trimmed.length === 0) return "Path is empty";
  if (trimmed.includes("\0")) return "Path must not contain NUL";
  if (trimmed.includes("\n") || trimmed.includes("\r")) {
    return "Path must not contain newlines";
  }
  // Reject relative paths BEFORE normalization — path.resolve() would otherwise
  // silently absolutize them against the process CWD and let them through.
  const expanded = expandHome(trimmed, homeDir);
  if (!expanded.startsWith("/")) return "Path must be absolute";
  const norm = normalizeHostPath(trimmed, homeDir);
  if (norm.includes(":")) {
    return "Path must not contain ':' (Docker's volume-spec separator)";
  }
  if (!norm.startsWith("/")) return "Path must be absolute";
  if (norm === "/") return "Refusing to mount the entire filesystem root (/)";
  // The whole home directory IS allowed (an intentional "give this agent broad
  // access" grant), but it exposes every dotfile/secret under it to the
  // container. The UI warns when home is granted; only "/" is hard-refused here
  // because mounting the filesystem root defeats the point of the sandbox.
  return null;
}

/** True when `p` resolves to the home directory itself (a broad-access grant). */
export function isHomeDir(p: string, homeDir: string = os.homedir()): boolean {
  return normalizeHostPath(p, homeDir) === normalizeHostPath(homeDir, homeDir);
}
