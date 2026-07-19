// Worker-side filesystem tree source. The Paperclip SDK exposes no directory
// browse capability, so the worker (which runs in the host node runtime and
// has fs access) enumerates one directory level at a time over `ctx.data`; the
// UI lazily expands nodes. Listing is confined to the caller's allowed roots
// so this is not a general host-filesystem-listing surface.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { normalizeHostPath } from "./docker.js";

export interface TreeEntry {
  name: string;
  path: string;
  isDir: boolean;
}

/** Hard cap on entries returned for one directory to bound payload size. */
const MAX_ENTRIES = 2000;

/** The default browse roots: the user's home directory. */
export function defaultRoots(homeDir: string = os.homedir()): string[] {
  return [normalizeHostPath(homeDir, homeDir)];
}

function isWithinRoots(target: string, roots: string[]): boolean {
  return roots.some((root) => {
    const r = normalizeHostPath(root);
    return target === r || target.startsWith(r.endsWith("/") ? r : r + "/");
  });
}

/**
 * List the immediate children of `dirPath`, sorted directories-first then
 * case-insensitively by name. `roots` is the set of allowed browse roots; a
 * request outside all of them is rejected (the tree cannot escape its roots).
 */
export async function listDir(
  dirPath: string,
  roots: string[],
  homeDir: string = os.homedir(),
): Promise<TreeEntry[]> {
  const target = normalizeHostPath(dirPath, homeDir);
  const normRoots = roots.map((r) => normalizeHostPath(r, homeDir));
  if (!isWithinRoots(target, normRoots)) {
    throw new Error(`Path is outside the allowed roots: ${target}`);
  }

  let dirents;
  try {
    dirents = await fs.readdir(target, { withFileTypes: true });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") throw new Error(`No such directory: ${target}`);
    if (e.code === "ENOTDIR") throw new Error(`Not a directory: ${target}`);
    if (e.code === "EACCES") throw new Error(`Permission denied: ${target}`);
    throw err;
  }

  const entries: TreeEntry[] = [];
  for (const d of dirents) {
    if (entries.length >= MAX_ENTRIES) break;
    // Report the entry as a directory when it is one, or a symlink that
    // resolves to one — but never follow the link for listing.
    let isDir = d.isDirectory();
    if (d.isSymbolicLink()) {
      try {
        isDir = (await fs.stat(path.join(target, d.name))).isDirectory();
      } catch {
        isDir = false;
      }
    }
    entries.push({ name: d.name, path: path.join(target, d.name), isDir });
  }

  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
  return entries;
}
