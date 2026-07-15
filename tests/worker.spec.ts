import { beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Agent } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.ts";
import plugin from "../src/worker.ts";
import { ENV_KEY } from "../src/hermes.ts";
import type { AgentWriteAccess } from "../src/worker.ts";

const COMPANY = "company-1";

function makeAgent(input: {
  id: string;
  name: string;
  adapterType: string;
  hermesHome?: string;
}): Agent {
  return {
    id: input.id,
    companyId: COMPANY,
    name: input.name,
    adapterType: input.adapterType,
    adapterConfig: input.hermesHome ? { env: { HERMES_HOME: input.hermesHome } } : {},
    // Fields below are irrelevant to this plugin; the harness only needs the
    // record to exist.
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

async function setupHarness(hermesHome: string) {
  const harness = createTestHarness({ manifest });
  harness.seed({
    agents: [
      makeAgent({
        id: "agent-hermes",
        name: "ord-engineer",
        adapterType: "hermes_local",
        hermesHome,
      }),
      makeAgent({
        id: "agent-claude",
        name: "claude-worker",
        adapterType: "claude_local",
      }),
    ],
  });
  await plugin.definition.setup(harness.ctx);
  return harness;
}

let home: string;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "fam-worker-"));
});

describe("worker bridge handlers", () => {
  test("hermes-agents lists agents with configurability", async () => {
    const harness = await setupHarness(home);
    const agents = await harness.getData<
      { id: string; configurable: boolean; hermesHome: string | null }[]
    >("hermes-agents", { companyId: COMPANY });
    const byId = Object.fromEntries(agents.map((a) => [a.id, a]));
    expect(byId["agent-hermes"].configurable).toBe(true);
    expect(byId["agent-hermes"].hermesHome).toBe(home);
    expect(byId["agent-claude"].configurable).toBe(false);
  });

  test("agent-write-access reads roots and never leaks .env contents", async () => {
    await fs.writeFile(
      path.join(home, ".env"),
      `SECRET_TOKEN=hunter2\n${ENV_KEY}=/data:/srv\n`,
    );
    const harness = await setupHarness(home);
    const result = await harness.getData<AgentWriteAccess>("agent-write-access", {
      companyId: COMPANY,
      agentId: "agent-hermes",
    });
    expect(result.roots).toEqual(["/data", "/srv"]);
    expect(result.configurable).toBe(true);
    expect(result.protectedPaths.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  test("set-agent-write-access persists roots to the profile .env", async () => {
    await fs.writeFile(path.join(home, ".env"), "SECRET_TOKEN=hunter2\n");
    const harness = await setupHarness(home);
    await harness.performAction("set-agent-write-access", {
      companyId: COMPANY,
      agentId: "agent-hermes",
      roots: ["/data", "~/vault"],
    });
    const written = await fs.readFile(path.join(home, ".env"), "utf8");
    expect(written).toBe(`SECRET_TOKEN=hunter2\n${ENV_KEY}=/data:~/vault\n`);
  });

  test("set-agent-write-access rejects non-Hermes agents", async () => {
    const harness = await setupHarness(home);
    await expect(
      harness.performAction("set-agent-write-access", {
        companyId: COMPANY,
        agentId: "agent-claude",
        roots: ["/data"],
      }),
    ).rejects.toThrow("cannot configure");
  });

  test("set-agent-write-access rejects invalid roots", async () => {
    const harness = await setupHarness(home);
    await expect(
      harness.performAction("set-agent-write-access", {
        companyId: COMPANY,
        agentId: "agent-hermes",
        roots: ["not-absolute"],
      }),
    ).rejects.toThrow("Invalid write root");
  });

  test("unknown agent returns a structured error", async () => {
    const harness = await setupHarness(home);
    await expect(
      harness.getData("agent-write-access", {
        companyId: COMPANY,
        agentId: "nope",
      }),
    ).rejects.toThrow("Agent not found");
  });
});
