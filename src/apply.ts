// Post-save runtime application. Writing .env/config.yaml is necessary but not
// sufficient: a running Hermes gateway holds the old TERMINAL_ENV in memory, and
// the Docker backend reuses its persistent container by LABEL ONLY — it never
// compares mounts (hermes-agent tools/environments/docker.py:892). So a file-
// access change only takes effect after (a) the profile's container is removed
// and (b) the gateway restarts. This module orchestrates both, best-effort, and
// reports each step's status so the UI can show progress ending in "ready".

import { execFile } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

export interface CommandResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the binary itself could not be run (e.g. "ENOENT" = not installed). */
  errno?: string;
}

export type RunCommand = (cmd: string, args: string[], timeoutMs?: number) => Promise<CommandResult>;

/** Default runner: execFile so args never hit a shell (no injection, no secrets in argv). */
export const runCommand: RunCommand = (cmd, args, timeoutMs = 20_000) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        resolve({ ok: false, code: null, stdout: "", stderr: "", errno: "ENOENT" });
        return;
      }
      const code = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
      resolve({ ok: !err, code, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });

export type StepStatus = "ok" | "skipped" | "failed";

export interface ApplyStep {
  /** Machine key: "config" | "docker" | "gateway". */
  key: string;
  /** Human label shown in the UI, e.g. "Restart Hermes gateway". */
  label: string;
  status: StepStatus;
  detail: string;
}

export interface ApplyResult {
  steps: ApplyStep[];
  /** "ready" when nothing failed; "needs-attention" when any step failed. */
  state: "ready" | "needs-attention";
}

const LABEL_VALUE_BAD = /[^A-Za-z0-9._-]/g;

/** Mirror hermes docker.py `_sanitize_label_value`: alnum + `._-`, ≤63, else "unknown". */
export function sanitizeLabelValue(value: string): string {
  if (typeof value !== "string" || value.length === 0) return "unknown";
  const cleaned = value.replace(LABEL_VALUE_BAD, "_").slice(0, 63);
  return cleaned.length > 0 ? cleaned : "unknown";
}

/** The `hermes-profile` container-label value Hermes tags containers with. */
export function profileLabelValue(profile: { name: string; isMain: boolean }): string {
  // hermes `_get_active_profile_name()` returns "default" for the ~/.hermes home.
  return sanitizeLabelValue(profile.isMain ? "default" : profile.name);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The container runtime binary Hermes will use for this profile. Hermes selects
 * it via `HERMES_DOCKER_BINARY` (Podman is supported that way); the plugin's
 * container-recreate step MUST use the same binary, or on a Podman host it would
 * run `docker ps` against nothing, silently skip, and leave the stale container
 * with the old mounts in place. Precedence: the profile's own `.env` value, then
 * the worker process environment, then `docker`.
 */
export function resolveDockerBinary(profileValue?: string | null): string {
  const fromProfile = profileValue?.trim();
  if (fromProfile) return fromProfile;
  const fromEnv = process.env.HERMES_DOCKER_BINARY?.trim();
  if (fromEnv) return fromEnv;
  return "docker";
}

/** Human label for the runtime, for step details ("Docker"/"Podman"/the binary). */
function runtimeLabel(binary: string): string {
  const base = binary.split("/").pop() || binary;
  if (base === "docker") return "Docker";
  if (base === "podman") return "Podman";
  return base;
}

/**
 * Remove the profile's persistent Hermes container(s) so the next tool call
 * recreates one with the new mounts. Best-effort: absent runtime CLI or no
 * matching container is a "skipped"/"ok", never a failure. `binary` is the
 * container runtime Hermes uses (docker/podman) — see resolveDockerBinary.
 */
export async function recreateContainerStep(
  labelValue: string,
  run: RunCommand = runCommand,
  binary = "docker",
): Promise<ApplyStep> {
  const key = "docker";
  const rt = runtimeLabel(binary);
  const label = `Recreate ${rt} container`;
  const list = await run(binary, [
    "ps", "-aq",
    "--filter", "label=hermes-agent=1",
    "--filter", `label=hermes-profile=${labelValue}`,
  ]);
  if (list.errno === "ENOENT") {
    return { key, label, status: "skipped", detail: `${rt} CLI (${binary}) not available on the host — skipped.` };
  }
  if (!list.ok) {
    return { key, label, status: "failed", detail: `${binary} ps failed: ${list.stderr.trim() || `exit ${list.code}`}` };
  }
  const ids = list.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) {
    return { key, label, status: "ok", detail: "No existing container — a fresh one starts on next use." };
  }
  const rm = await run(binary, ["rm", "-f", ...ids], 60_000);
  if (!rm.ok) {
    return { key, label, status: "failed", detail: `${binary} rm -f failed: ${rm.stderr.trim() || `exit ${rm.code}`}` };
  }
  return { key, label, status: "ok", detail: `Removed ${ids.length} stale container(s); new mounts apply on next use.` };
}

/**
 * Find the systemd --user gateway unit whose `HERMES_HOME=` resolves to
 * `hermesHome`. Returns the unit name, or null when none matches (profiles
 * without a gateway unit are common — those just get a "skipped" step).
 */
export async function findGatewayUnit(
  hermesHome: string,
  run: RunCommand = runCommand,
): Promise<string | null> {
  const list = await run("systemctl", [
    "--user", "list-unit-files", "hermes-gateway*.service", "--no-legend", "--plain",
  ]);
  if (!list.ok || list.errno) return null;
  const units = list.stdout
    .split("\n")
    .map((l) => l.trim().split(/\s+/)[0])
    .filter((u) => u && u.endsWith(".service"));
  const target = path.resolve(hermesHome);
  for (const unit of units) {
    const show = await run("systemctl", ["--user", "show", unit, "--property=Environment", "--value"]);
    if (!show.ok) continue;
    const m = show.stdout.match(/HERMES_HOME=([^\s]+)/);
    const home = m ? m[1] : path.join(os.homedir(), ".hermes");
    // A unit with no --profile / no HERMES_HOME override is the main/default home.
    if (path.resolve(home) === target) return unit;
  }
  return null;
}

/**
 * Restart the gateway unit and poll until it reports active. Only restarts a
 * unit that is currently active — a stopped gateway is left stopped (the user
 * turned it off on purpose).
 */
export async function restartGatewayStep(
  hermesHome: string,
  run: RunCommand = runCommand,
  opts: { pollMs?: number; attempts?: number } = {},
): Promise<ApplyStep> {
  const key = "gateway";
  const label = "Restart Hermes gateway";
  const unit = await findGatewayUnit(hermesHome, run);
  if (!unit) {
    return { key, label, status: "skipped", detail: "No systemd --user gateway unit for this profile — restart it manually if it runs elsewhere." };
  }
  const active = await run("systemctl", ["--user", "is-active", unit]);
  if (active.errno === "ENOENT") {
    return { key, label, status: "skipped", detail: "systemctl --user not available — restart the gateway manually." };
  }
  if (active.stdout.trim() !== "active") {
    return { key, label, status: "skipped", detail: `${unit} is not running (${active.stdout.trim() || "inactive"}) — left stopped.` };
  }
  const restart = await run("systemctl", ["--user", "restart", unit], 60_000);
  if (!restart.ok) {
    return { key, label, status: "failed", detail: `restart ${unit} failed: ${restart.stderr.trim() || `exit ${restart.code}`}` };
  }
  const attempts = opts.attempts ?? 12;
  const pollMs = opts.pollMs ?? 1_000;
  for (let i = 0; i < attempts; i++) {
    const st = await run("systemctl", ["--user", "is-active", unit]);
    if (st.stdout.trim() === "active") {
      return { key, label, status: "ok", detail: `${unit} restarted and active.` };
    }
    await sleep(pollMs);
  }
  return { key, label, status: "failed", detail: `${unit} did not report active within ${attempts}s — check its logs.` };
}

/** Orchestrate container recreation + gateway restart for one profile. */
export async function applyRuntime(
  profile: { name: string; isMain: boolean; hermesHome: string },
  run: RunCommand = runCommand,
  opts: { pollMs?: number; attempts?: number } = {},
  binary = "docker",
): Promise<ApplyStep[]> {
  const steps: ApplyStep[] = [];
  steps.push(await recreateContainerStep(profileLabelValue(profile), run, binary));
  steps.push(await restartGatewayStep(profile.hermesHome, run, opts));
  return steps;
}

/** Roll a step list into an overall state. */
export function overallState(steps: ApplyStep[]): "ready" | "needs-attention" {
  return steps.some((s) => s.status === "failed") ? "needs-attention" : "ready";
}
