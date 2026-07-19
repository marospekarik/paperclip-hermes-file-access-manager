// Real-Docker integration harness. These tests launch actual containers and
// assert that DOCKER — not the application — enforces filesystem permissions.
//
// A container is started with the exact `-v <spec>` mapping Hermes uses
// (hermes-agent tools/environments/docker.py:661) plus the security-relevant
// subset of Hermes's hardening flags, then filesystem operations are executed
// INSIDE the container via `docker exec` and verified against both the
// container view and the host filesystem.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { generateDockerVolumes, type Assignment } from "../../src/model.ts";

export type { Assignment };

const IMAGE = process.env.FAM_TEST_IMAGE ?? "alpine:3.20";
const LABEL = "fam-test=1";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function sh(args: string[], timeoutMs = 120_000): Promise<RunResult> {
  const proc = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, stdout, stderr };
}

/** True when a working Docker daemon is reachable. */
export async function dockerAvailable(): Promise<boolean> {
  try {
    const r = await sh(["version", "--format", "{{.Server.Version}}"], 10_000);
    return r.code === 0 && r.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

let imageReady = false;
export async function ensureImage(): Promise<void> {
  if (imageReady) return;
  const present = await sh(["image", "inspect", IMAGE], 15_000);
  if (present.code !== 0) {
    const pull = await sh(["pull", IMAGE], 180_000);
    if (pull.code !== 0) throw new Error(`docker pull ${IMAGE} failed: ${pull.stderr}`);
  }
  imageReady = true;
}

function hostUserSpec(): string {
  // Mirror docker.py _resolve_host_user_spec so files written into rw mounts
  // are owned by the host user and visible/readable back on the host.
  return `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
}

export interface Container {
  id: string;
  exec(cmd: string): Promise<RunResult>;
  /** Returns whether the bind mount at `dest` is read-write, per docker inspect. */
  mountIsRW(dest: string): Promise<boolean>;
  remove(): Promise<void>;
}

/**
 * Start a container with the given docker_volumes specs and Hermes's
 * security-relevant flags. `runAsHostUser` (default true) adds `--user`.
 */
export async function runContainer(
  volumes: string[],
  opts: { runAsHostUser?: boolean } = {},
): Promise<Container> {
  await ensureImage();
  const runAsHostUser = opts.runAsHostUser ?? true;
  const name = `fam-test-${crypto.randomUUID().slice(0, 8)}`;
  const securityArgs = [
    "--cap-drop", "ALL",
    "--cap-add", "DAC_OVERRIDE",
    "--cap-add", "CHOWN",
    "--cap-add", "FOWNER",
    "--security-opt", "no-new-privileges",
  ];
  const userArgs = runAsHostUser ? ["--user", hostUserSpec()] : [];
  const volumeArgs = volumes.flatMap((v) => ["-v", v]); // exactly docker.py:661
  const r = await sh([
    "run", "-d",
    "--name", name,
    "--label", LABEL,
    ...securityArgs,
    ...userArgs,
    ...volumeArgs,
    IMAGE,
    "sleep", "infinity",
  ]);
  if (r.code !== 0) throw new Error(`docker run failed: ${r.stderr.trim()}`);
  const id = r.stdout.trim();

  return {
    id,
    async exec(cmd: string) {
      return sh(["exec", id, "sh", "-c", cmd]);
    },
    async mountIsRW(dest: string) {
      const insp = await sh([
        "inspect",
        "--format",
        `{{range .Mounts}}{{if eq .Destination "${dest}"}}{{.RW}}{{end}}{{end}}`,
        id,
      ]);
      return insp.stdout.trim() === "true";
    },
    async remove() {
      await sh(["rm", "-f", id], 30_000);
    },
  };
}

/** Remove any leftover test containers (label-scoped). */
export async function reapTestContainers(): Promise<void> {
  const list = await sh(["ps", "-aq", "--filter", `label=${LABEL}`]);
  const ids = list.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  if (ids.length > 0) await sh(["rm", "-f", ...ids], 60_000);
}

// --- host workspace helpers ---------------------------------------------

export interface Workspace {
  root: string;
  /** Absolute host path for a workspace-relative path. */
  at(rel: string): string;
  cleanup(): Promise<void>;
}

/** Create a temp host workspace and realpath it (macOS /var → /private/var). */
export async function makeWorkspace(): Promise<Workspace> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "fam-ws-"));
  const root = await fs.realpath(base);
  return {
    root,
    at: (rel: string) => path.join(root, rel),
    cleanup: () => fs.rm(base, { recursive: true, force: true }),
  };
}

/** Create an empty, realpath'd directory to serve as the deny mask source. */
export async function makeMaskDir(): Promise<{ dir: string; cleanup(): Promise<void> }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "fam-mask-"));
  const dir = await fs.realpath(base);
  await fs.chmod(dir, 0o555).catch(() => {});
  return { dir, cleanup: () => fs.rm(base, { recursive: true, force: true }) };
}

/** Convenience: assignments → volume specs with a fresh mask dir. */
export function volumesFor(assignments: Assignment[], maskDir: string): string[] {
  return generateDockerVolumes(assignments, { maskDir });
}
