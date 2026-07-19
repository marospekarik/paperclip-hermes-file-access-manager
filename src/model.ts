// Pure permission model + Docker bind-mount translation. NO node imports — this
// module is shared by the worker (node) and the UI (browser), so it must stay
// free of `node:*` so it bundles for both targets.
//
// Permission model:
//   Read/Write  → mount `-v <path>:<path>`        (writable bind mount)
//   Read Only   → mount `-v <path>:<path>:ro`     (read-only bind mount)
//   Denied      → not mounted at all — UNLESS it sits under a mounted (rw/ro)
//                 ancestor, in which case an empty read-only dir is mounted
//                 over it so Docker's more-specific nested mount masks the host
//                 content the ancestor would otherwise expose.
//
// Identity mapping (host path == container path) keeps translation a pure
// equality and the agent's view of the filesystem identical to the host's.

export type Mode = "rw" | "ro" | "denied";

/** One explicit, user-assigned permission on an absolute host path. */
export interface Assignment {
  path: string;
  mode: Mode;
}

/** The full stored access model for one agent. */
export interface AgentAccess {
  /** Top-level roots shown in the tree (home is always implied). */
  roots: string[];
  /** Explicit per-path assignments; everything else inherits or is denied. */
  assignments: Assignment[];
}

export const DEFAULT_MODE: Mode = "denied";

export function isAncestor(ancestor: string, child: string): boolean {
  if (ancestor === child) return false;
  return child.startsWith(ancestor.endsWith("/") ? ancestor : ancestor + "/");
}

/**
 * The effective mode at `target`: the mode of the nearest explicit ancestor
 * (or the explicit assignment on `target` itself), falling back to the secure
 * default (`denied`). Reports whether that mode is inherited and from where —
 * the UI uses this to render inherited vs. explicit state.
 */
export function resolveEffectiveMode(
  target: string,
  assignments: Assignment[],
): { mode: Mode; inherited: boolean; source: string | null } {
  let best: { path: string; mode: Mode } | null = null;
  for (const a of assignments) {
    if (a.path === target || isAncestor(a.path, target)) {
      if (best === null || a.path.length > best.path.length) {
        best = { path: a.path, mode: a.mode };
      }
    }
  }
  if (best === null) return { mode: DEFAULT_MODE, inherited: false, source: null };
  return {
    mode: best.mode,
    inherited: best.path !== target,
    source: best.path === target ? null : best.path,
  };
}

/** The nearest strict-ancestor explicit assignment, or null. */
function nearestStrictAncestor(target: string, assignments: Assignment[]): Assignment | null {
  let best: Assignment | null = null;
  for (const a of assignments) {
    if (isAncestor(a.path, target)) {
      if (best === null || a.path.length > best.path.length) best = a;
    }
  }
  return best;
}

export interface VolumeOptions {
  /** Absolute path to an empty, read-only directory used to mask denied paths. */
  maskDir: string;
}

/**
 * Translate explicit assignments into the exact `docker_volumes` list Hermes
 * feeds to `docker run` (each entry becomes `-v <spec>`; see hermes-agent
 * tools/environments/docker.py:653-666). Deterministic, sorted by mount
 * destination.
 *
 *   rw     → "<path>:<path>"
 *   ro     → "<path>:<path>:ro"
 *   denied → "<maskDir>:<path>:ro"  (only when a mounted ancestor exposes it;
 *            otherwise omitted)
 */
export function generateDockerVolumes(
  assignments: Assignment[],
  opts: VolumeOptions,
): string[] {
  const specs: string[] = [];
  for (const a of assignments) {
    if (a.mode === "rw") {
      specs.push(`${a.path}:${a.path}`);
    } else if (a.mode === "ro") {
      specs.push(`${a.path}:${a.path}:ro`);
    } else {
      const anc = nearestStrictAncestor(a.path, assignments);
      if (anc && (anc.mode === "rw" || anc.mode === "ro")) {
        specs.push(`${opts.maskDir}:${a.path}:ro`);
      }
    }
  }
  return specs.sort((x, y) => destOf(x).localeCompare(destOf(y)));
}

function destOf(spec: string): string {
  const first = spec.indexOf(":");
  const rest = spec.slice(first + 1);
  return rest.endsWith(":ro") ? rest.slice(0, -3) : rest;
}
