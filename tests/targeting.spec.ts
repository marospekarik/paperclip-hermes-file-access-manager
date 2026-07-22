// Profile-targeting + configuration-persistence tests for the worker action.
// These drive the real `set-profile-access` handler through the SDK test
// harness and assert that config lands ONLY on the selected profile(s) — the
// main/router profile is never touched unless explicitly selected.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Agent } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.ts";
import plugin from "../src/worker.ts";

const COMPANY = "company-1";

function makeAgent(input: {
  id: string;
  name: string;
  adapterType: string;
  /** Full adapterConfig, matching the real hermes-paperclip-adapter shape. */
  adapterConfig?: Record<string, unknown>;
}): Agent {
  return {
    id: input.id,
    companyId: COMPANY,
    name: input.name,
    adapterType: input.adapterType,
    adapterConfig: input.adapterConfig ?? {},
    urlKey: input.id,
    role: "employee",
    title: null,
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: {},
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as Agent;
}

const temps: string[] = [];

/** A profile home seeded with unrelated .env + config.yaml content. */
async function seedProfileHome(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, ".env"),
    "OPENAI_API_KEY=sk-preexisting\nDISCORD_BOT_TOKEN=abc\n",
  );
  await fs.writeFile(
    path.join(dir, "config.yaml"),
    "discord:\n  enabled: true\nterminal:\n  backend: local\n  timeout: 60\n",
  );
}

let root: string;
let grantDir: string;
let grantReal: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "fam-root-"));
  temps.push(root);
  await seedProfileHome(root); // main
  await seedProfileHome(path.join(root, "profiles", "coder"));
  await seedProfileHome(path.join(root, "profiles", "writer"));

  grantDir = await fs.mkdtemp(path.join(os.tmpdir(), "fam-grant-"));
  temps.push(grantDir);
  grantReal = await fs.realpath(grantDir);

  process.env.FAM_HERMES_ROOT = root;
  // Never touch the real docker/systemctl from unit tests.
  process.env.FAM_SKIP_RUNTIME_APPLY = "1";
});

afterEach(async () => {
  delete process.env.FAM_HERMES_ROOT;
  delete process.env.FAM_SKIP_RUNTIME_APPLY;
  for (const t of temps.splice(0)) await fs.rm(t, { recursive: true, force: true });
});

/**
 * A `hermes profile alias` wrapper — the shape real agents use to select a
 * profile (`hermesCommand` points at it; the `-p` lives inside).
 */
async function makeWrapper(name: string, profile: string): Promise<string> {
  const bin = path.join(root, "bin");
  await fs.mkdir(bin, { recursive: true });
  const file = path.join(bin, name);
  await fs.writeFile(file, `#!/bin/sh\nexec /usr/local/bin/hermes -p ${profile} "$@"\n`, {
    mode: 0o755,
  });
  return file;
}

async function setup() {
  const harness = createTestHarness({ manifest });
  harness.seed({
    agents: [
      // The real-world shape: profile selected by an alias wrapper, plus the
      // decorative `profile` field Paperclip writes but the adapter ignores.
      makeAgent({
        id: "agent-coder",
        name: "coder-bot",
        adapterType: "hermes_local",
        adapterConfig: {
          model: "zai/glm-5.1",
          profile: "coder",
          hermesCommand: await makeWrapper("coder", "coder"),
        },
      }),
      makeAgent({ id: "agent-main", name: "router", adapterType: "hermes_local" }),
      makeAgent({
        id: "agent-orphan",
        name: "orphan",
        adapterType: "hermes_local",
        adapterConfig: { env: { HERMES_HOME: "/nonexistent/profiles/ghost" } },
      }),
      makeAgent({ id: "agent-claude", name: "claude", adapterType: "claude_local" }),
    ],
  });
  await plugin.definition.setup(harness.ctx);
  return harness;
}

const rwGrant = () => ({ roots: [os.homedir()], assignments: [{ path: grantReal, mode: "rw" }] });

async function readFileText(p: string): Promise<string> {
  return fs.readFile(p, "utf8");
}

describe("hermes-profiles discovery endpoint", () => {
  test("returns main first, flagged, then specialized profiles", async () => {
    const h = await setup();
    const res = await h.getData<{ homeDir: string; profiles: { name: string; isMain: boolean }[] }>(
      "hermes-profiles",
      {},
    );
    expect(res.profiles.map((p) => p.name)).toEqual(["main", "coder", "writer"]);
    expect(res.profiles.find((p) => p.name === "main")!.isMain).toBe(true);
    expect(res.profiles.find((p) => p.name === "coder")!.isMain).toBe(false);
  });
});

describe("set-profile-access — correct targeting", () => {
  test("writes ONLY to the selected profile; main and siblings untouched", async () => {
    const h = await setup();
    const mainEnvBefore = await readFileText(path.join(root, ".env"));
    const mainCfgBefore = await readFileText(path.join(root, "config.yaml"));
    const writerEnvBefore = await readFileText(path.join(root, "profiles", "writer", ".env"));

    await h.performAction("set-profile-access", { profiles: ["coder"], ...rwGrant() });

    // Selected profile got the Docker backend + the mount, unrelated keys kept.
    const coderEnv = await readFileText(path.join(root, "profiles", "coder", ".env"));
    expect(coderEnv).toContain("TERMINAL_ENV=docker");
    expect(coderEnv).toContain("TERMINAL_DOCKER_RUN_AS_HOST_USER=true");
    expect(coderEnv).toContain(`${grantReal}:${grantReal}`);
    expect(coderEnv).toContain("OPENAI_API_KEY=sk-preexisting"); // preserved
    const coderCfg = await readFileText(path.join(root, "profiles", "coder", "config.yaml"));
    expect(coderCfg).toContain("backend: docker");
    expect(coderCfg).toContain("discord:"); // preserved

    // Main (router) and the other profile are byte-identical to before.
    expect(await readFileText(path.join(root, ".env"))).toBe(mainEnvBefore);
    expect(await readFileText(path.join(root, "config.yaml"))).toBe(mainCfgBefore);
    expect(await readFileText(path.join(root, "profiles", "writer", ".env"))).toBe(
      writerEnvBefore,
    );
  });

  test("multiple selected profiles are all configured in one call", async () => {
    const h = await setup();
    const res = await h.performAction<{ profiles: { profile: string }[] }>(
      "set-profile-access",
      { profiles: ["coder", "writer"], ...rwGrant() },
    );
    expect(res.profiles.map((p) => p.profile).sort()).toEqual(["coder", "writer"]);
    for (const name of ["coder", "writer"]) {
      const env = await readFileText(path.join(root, "profiles", name, ".env"));
      expect(env).toContain("TERMINAL_ENV=docker");
    }
    // main still untouched
    expect(await readFileText(path.join(root, ".env"))).not.toContain("TERMINAL_ENV=docker");
  });

  test("returns per-profile apply steps and a state", async () => {
    const h = await setup();
    const res = await h.performAction<{
      profiles: { profile: string; state: string; steps: { key: string; status: string }[] }[];
    }>("set-profile-access", { profiles: ["coder"], ...rwGrant() });
    const p = res.profiles[0];
    expect(p.profile).toBe("coder");
    expect(p.state).toBe("ready");
    expect(p.steps.find((s) => s.key === "config")?.status).toBe("ok");
    // runtime apply is disabled in tests → reported as skipped, not run
    expect(p.steps.find((s) => s.key === "runtime")?.status).toBe("skipped");
  });

  test("main is configured only when explicitly selected", async () => {
    const h = await setup();
    await h.performAction("set-profile-access", { profiles: ["main"], ...rwGrant() });
    expect(await readFileText(path.join(root, ".env"))).toContain("TERMINAL_ENV=docker");
  });

  test("rejects an unknown profile without writing anything", async () => {
    const h = await setup();
    const before = await readFileText(path.join(root, "profiles", "coder", ".env"));
    await expect(
      h.performAction("set-profile-access", { profiles: ["ghost"], ...rwGrant() }),
    ).rejects.toThrow(/Unknown Hermes profile/);
    expect(await readFileText(path.join(root, "profiles", "coder", ".env"))).toBe(before);
  });

  test("rejects an empty profile selection", async () => {
    const h = await setup();
    await expect(
      h.performAction("set-profile-access", { profiles: [], ...rwGrant() }),
    ).rejects.toThrow(/at least one profile/);
  });

  test("rejects granting a path that does not exist", async () => {
    const h = await setup();
    await expect(
      h.performAction("set-profile-access", {
        profiles: ["coder"],
        roots: [os.homedir()],
        assignments: [{ path: "/no/such/path/here", mode: "rw" }],
      }),
    ).rejects.toThrow(/missing path/);
  });
});

describe("set-profile-access — configuration persistence", () => {
  test("stored state round-trips through profile-access", async () => {
    const h = await setup();
    await h.performAction("set-profile-access", { profiles: ["coder"], ...rwGrant() });
    const res = await h.getData<{ assignments: { path: string; mode: string }[]; volumesPreview: string[] }>(
      "profile-access",
      { profile: "coder" },
    );
    expect(res.assignments).toEqual([{ path: grantReal, mode: "rw" }]);
    expect(res.volumesPreview).toContain(`${grantReal}:${grantReal}`);
  });

  test("re-saving updates the same keys without duplicating them", async () => {
    const h = await setup();
    await h.performAction("set-profile-access", { profiles: ["coder"], ...rwGrant() });
    await h.performAction("set-profile-access", {
      profiles: ["coder"],
      roots: [os.homedir()],
      assignments: [{ path: grantReal, mode: "ro" }],
    });
    const env = await readFileText(path.join(root, "profiles", "coder", ".env"));
    expect(env.match(/^TERMINAL_ENV=/gm)?.length).toBe(1);
    expect(env).toContain(`${grantReal}:${grantReal}:ro`);
  });
});

type AgentProfilePayload = {
  profile: string | null;
  isMain: boolean;
  configurable: boolean;
  profileSource: string;
  hermesHome: string;
  declaredProfile: string | null;
  declaredMismatch: boolean;
};

const agentProfile = (h: Awaited<ReturnType<typeof setup>>, agentId: string) =>
  h.getData<AgentProfilePayload>("agent-profile", { companyId: COMPANY, agentId });

describe("agent-profile resolution", () => {
  test("maps an agent to its profile via the hermesCommand wrapper's -p flag", async () => {
    const h = await setup();
    const res = await agentProfile(h, "agent-coder");
    expect(res.profile).toBe("coder");
    expect(res.isMain).toBe(false);
    expect(res.profileSource).toBe("hermes-command");
    expect(res.declaredMismatch).toBe(false);
  });

  test("an agent with nothing selecting a profile resolves to main", async () => {
    const h = await setup();
    const res = await agentProfile(h, "agent-main");
    expect(res.profile).toBe("main");
    expect(res.isMain).toBe(true);
    expect(res.profileSource).toBe("default");
  });

  test("an agent whose HERMES_HOME matches no profile resolves to null (never main)", async () => {
    const h = await setup();
    const res = await agentProfile(h, "agent-orphan");
    expect(res.profile).toBeNull();
    expect(res.profileSource).toBe("env");
  });

  test("a non-Hermes agent is not configurable", async () => {
    const h = await setup();
    const res = await agentProfile(h, "agent-claude");
    expect(res.configurable).toBe(false);
    expect(res.profile).toBeNull();
  });
});

describe("hermes-agents roster", () => {
  test("lists only Hermes agents, counts the rest, and resolves each profile", async () => {
    const h = await setup();
    const res = await h.getData<{
      agents: { agentName: string; profile: string | null; profileSource: string }[];
      hiddenNonHermes: number;
      truncated: boolean;
    }>("hermes-agents", { companyId: COMPANY });

    expect(res.agents.map((a) => a.agentName)).toEqual(["coder-bot", "orphan", "router"]);
    expect(res.agents.find((a) => a.agentName === "coder-bot")!.profile).toBe("coder");
    expect(res.agents.find((a) => a.agentName === "router")!.profile).toBe("main");
    expect(res.agents.find((a) => a.agentName === "orphan")!.profile).toBeNull();
    // The claude_local agent is excluded from the list but reported as hidden.
    expect(res.hiddenNonHermes).toBe(1);
    expect(res.truncated).toBe(false);
  });
});
