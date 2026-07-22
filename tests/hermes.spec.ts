// Profile-resolution tests. These pin the precedence chain against Hermes's
// own (`hermes_cli/main.py` `_apply_profile_override`), because a mismatch here
// means the plugin sandboxes a different profile than the agent runs on.

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  isHermesAdapter,
  profileFlagFromArgv,
  profileFromHermesCommand,
  resolveAgentProfile,
  resolveHermesHome,
} from "../src/hermes.ts";

const temps: string[] = [];

afterEach(async () => {
  for (const t of temps.splice(0)) await fs.rm(t, { recursive: true, force: true });
});

async function makeRoot(profiles: string[] = []): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fam-hermes-res-"));
  temps.push(root);
  await fs.writeFile(path.join(root, "config.yaml"), "terminal:\n  backend: local\n");
  for (const p of profiles) {
    const dir = path.join(root, "profiles", p);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "config.yaml"), "terminal:\n  backend: local\n");
  }
  return root;
}

/** A `hermes profile alias` wrapper script, as installed on a real host. */
async function makeWrapper(root: string, name: string, body: string): Promise<string> {
  const bin = path.join(root, "bin");
  await fs.mkdir(bin, { recursive: true });
  const file = path.join(bin, name);
  await fs.writeFile(file, body, { mode: 0o755 });
  return file;
}

describe("profileFlagFromArgv", () => {
  test("reads -p, --profile and --profile=", () => {
    expect(profileFlagFromArgv(["-p", "maker"])).toBe("maker");
    expect(profileFlagFromArgv(["--profile", "maker"])).toBe("maker");
    expect(profileFlagFromArgv(["--profile=maker"])).toBe("maker");
    expect(profileFlagFromArgv(["--yolo", "-p", "stage-manager", "--quiet"])).toBe("stage-manager");
  });

  test("stops at -- and ignores absent flags", () => {
    expect(profileFlagFromArgv(["--", "-p", "maker"])).toBeNull();
    expect(profileFlagFromArgv(["--yolo"])).toBeNull();
    expect(profileFlagFromArgv([])).toBeNull();
  });

  test("rejects values Hermes itself would reject", () => {
    // Hermes's _PROFILE_ID_RE is lowercase-only; "no:xdist" is its own worked example.
    expect(profileFlagFromArgv(["-p", "no:xdist"])).toBeNull();
    expect(profileFlagFromArgv(["-p", "Maker"])).toBeNull();
    expect(profileFlagFromArgv(["-p", "../evil"])).toBeNull();
  });
});

describe("profileFromHermesCommand", () => {
  test("extracts -p from an alias wrapper script", async () => {
    const root = await makeRoot(["maker"]);
    const wrapper = await makeWrapper(
      root,
      "maker",
      '#!/bin/sh\nexec /home/u/.local/bin/hermes -p maker "$@"\n',
    );
    expect(await profileFromHermesCommand(wrapper)).toBe("maker");
  });

  test("extracts -p from an inline command string", async () => {
    expect(await profileFromHermesCommand("hermes -p librarian")).toBe("librarian");
  });

  test("a bare hermes binary selects nothing", async () => {
    const root = await makeRoot();
    const wrapper = await makeWrapper(root, "hermes", '#!/bin/sh\nexec /usr/bin/hermes "$@"\n');
    expect(await profileFromHermesCommand(wrapper)).toBeNull();
    expect(await profileFromHermesCommand("hermes")).toBeNull();
  });

  test("a missing or non-absolute command is not an error", async () => {
    expect(await profileFromHermesCommand("/no/such/wrapper")).toBeNull();
    expect(await profileFromHermesCommand("relative/wrapper")).toBeNull();
    expect(await profileFromHermesCommand("")).toBeNull();
  });
});

describe("resolveHermesHome precedence", () => {
  test("extraArgs -p wins over env.HERMES_HOME (Hermes step 1 beats step 1.5)", async () => {
    const root = await makeRoot(["maker", "coder"]);
    const res = await resolveHermesHome(
      {
        extraArgs: ["--yolo", "-p", "maker"],
        env: { HERMES_HOME: path.join(root, "profiles", "coder") },
      },
      root,
    );
    expect(res.hermesHome).toBe(path.join(root, "profiles", "maker"));
    expect(res.source).toBe("extra-args");
  });

  test("the hermesCommand wrapper wins over env.HERMES_HOME", async () => {
    const root = await makeRoot(["maker", "coder"]);
    const wrapper = await makeWrapper(root, "maker", "#!/bin/sh\nexec hermes -p maker \"$@\"\n");
    const res = await resolveHermesHome(
      { hermesCommand: wrapper, env: { HERMES_HOME: path.join(root, "profiles", "coder") } },
      root,
    );
    expect(res.hermesHome).toBe(path.join(root, "profiles", "maker"));
    expect(res.source).toBe("hermes-command");
  });

  test("a profile-shaped env.HERMES_HOME is used when no flag selects one", async () => {
    const root = await makeRoot(["coder"]);
    const home = path.join(root, "profiles", "coder");
    const res = await resolveHermesHome({ env: { HERMES_HOME: home } }, root);
    expect(res.hermesHome).toBe(home);
    expect(res.source).toBe("env");
  });

  test("active_profile is honoured when nothing else selects a profile", async () => {
    const root = await makeRoot(["writer"]);
    await fs.writeFile(path.join(root, "active_profile"), "writer\n");
    const res = await resolveHermesHome({}, root);
    expect(res.hermesHome).toBe(path.join(root, "profiles", "writer"));
    expect(res.source).toBe("active-profile");
  });

  test("an empty adapterConfig falls back to the root", async () => {
    const root = await makeRoot(["maker"]);
    const res = await resolveHermesHome({}, root);
    expect(res.hermesHome).toBe(root);
    expect(res.source).toBe("default");
  });

  test("`-p default` maps to the root, as in Hermes", async () => {
    const root = await makeRoot(["maker"]);
    const res = await resolveHermesHome({ extraArgs: ["-p", "default"] }, root);
    expect(res.hermesHome).toBe(root);
  });

  test("the decorative `profile` field never decides the home", async () => {
    const root = await makeRoot(["maker"]);
    // The hermes adapter does not read adapterConfig.profile — trusting it here
    // would sandbox "maker" while the agent actually runs on the router profile.
    const res = await resolveHermesHome({ profile: "maker" }, root);
    expect(res.hermesHome).toBe(root);
    expect(res.source).toBe("default");
    expect(res.declaredProfile).toBe("maker");
  });
});

describe("resolveAgentProfile", () => {
  test("maps the real-world agent shape to its specialized profile", async () => {
    const root = await makeRoot(["librarian"]);
    const wrapper = await makeWrapper(
      root,
      "librarian",
      '#!/bin/sh\nexec /home/u/.local/bin/hermes -p librarian "$@"\n',
    );
    const profiles = [
      { name: "main", hermesHome: root },
      { name: "librarian", hermesHome: path.join(root, "profiles", "librarian") },
    ];
    const res = await resolveAgentProfile(
      { model: "zai/glm-5.1", profile: "librarian", hermesCommand: wrapper },
      profiles,
      root,
    );
    expect(res.profile).toBe("librarian");
    expect(res.declaredMismatch).toBe(false);
  });

  test("flags a declared profile that disagrees with the effective one", async () => {
    const root = await makeRoot(["maker", "coder"]);
    const wrapper = await makeWrapper(root, "maker", '#!/bin/sh\nexec hermes -p maker "$@"\n');
    const profiles = [
      { name: "main", hermesHome: root },
      { name: "maker", hermesHome: path.join(root, "profiles", "maker") },
    ];
    const res = await resolveAgentProfile(
      { profile: "coder", hermesCommand: wrapper },
      profiles,
      root,
    );
    expect(res.profile).toBe("maker");
    expect(res.declaredProfile).toBe("coder");
    expect(res.declaredMismatch).toBe(true);
  });

  test("an unmatched home resolves to null, never to main", async () => {
    const root = await makeRoot([]);
    const res = await resolveAgentProfile(
      { env: { HERMES_HOME: "/elsewhere/profiles/ghost" } },
      [{ name: "main", hermesHome: root }],
      root,
    );
    expect(res.profile).toBeNull();
  });
});

describe("isHermesAdapter", () => {
  test("accepts the registered adapter type and plausible siblings", () => {
    expect(isHermesAdapter("hermes_local")).toBe(true);
    expect(isHermesAdapter("hermes")).toBe(true);
    expect(isHermesAdapter("hermes_remote")).toBe(true);
  });

  test("rejects adapters that merely mention hermes", () => {
    expect(isHermesAdapter("claude_local")).toBe(false);
    expect(isHermesAdapter("codex_local")).toBe(false);
    expect(isHermesAdapter("not_hermes")).toBe(false);
    expect(isHermesAdapter("claude_hermes_bridge")).toBe(false);
    expect(isHermesAdapter(undefined)).toBe(false);
  });
});
