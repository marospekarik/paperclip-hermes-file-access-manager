import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import {
  PROTECTED_PATHS,
  isHermesAdapter,
  readRoots,
  resolveHermesHome,
  validateRoot,
  writeRoots,
} from "./hermes.js";

const ENFORCEMENT_NOTE =
  "Hermes restricts writes only (HERMES_WRITE_SAFE_ROOT); reads are " +
  "unrestricted. Changes apply when the agent's Hermes process next starts.";

export interface AgentWriteAccess {
  agentId: string;
  agentName: string;
  adapterType: string;
  configurable: boolean;
  hermesHome: string;
  roots: string[];
  protectedPaths: string[];
  note: string;
}

interface AgentParams {
  companyId?: unknown;
  agentId?: unknown;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

const plugin = definePlugin({
  async setup(ctx) {
    async function loadAgent(params: AgentParams) {
      const companyId = requireString(params.companyId, "companyId");
      const agentId = requireString(params.agentId, "agentId");
      const agent = await ctx.agents.get(agentId, companyId);
      if (!agent) throw new Error(`Agent not found: ${agentId}`);
      return agent;
    }

    ctx.data.register("hermes-agents", async (params) => {
      const companyId = requireString(
        (params as AgentParams).companyId,
        "companyId",
      );
      const agents = await ctx.agents.list({ companyId });
      return agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        adapterType: agent.adapterType,
        configurable: isHermesAdapter(agent.adapterType),
        hermesHome: isHermesAdapter(agent.adapterType)
          ? resolveHermesHome(agent.adapterConfig)
          : null,
      }));
    });

    ctx.data.register("agent-write-access", async (params) => {
      const agent = await loadAgent(params as AgentParams);
      const configurable = isHermesAdapter(agent.adapterType);
      const hermesHome = resolveHermesHome(agent.adapterConfig);
      const result: AgentWriteAccess = {
        agentId: agent.id,
        agentName: agent.name,
        adapterType: agent.adapterType,
        configurable,
        hermesHome,
        roots: configurable ? await readRoots(hermesHome) : [],
        protectedPaths: [...PROTECTED_PATHS],
        note: ENFORCEMENT_NOTE,
      };
      return result;
    });

    ctx.actions.register("set-agent-write-access", async (params) => {
      const agent = await loadAgent(params as AgentParams);
      if (!isHermesAdapter(agent.adapterType)) {
        throw new Error(
          `Agent ${agent.name} uses adapter "${agent.adapterType}", which this plugin cannot configure`,
        );
      }
      const rawRoots = (params as { roots?: unknown }).roots;
      if (!Array.isArray(rawRoots) || rawRoots.some((r) => typeof r !== "string")) {
        throw new Error("roots must be an array of strings");
      }
      const roots = (rawRoots as string[]).map((r) => r.trim());
      for (const root of roots) {
        const error = validateRoot(root);
        if (error) throw new Error(`Invalid write root "${root}": ${error}`);
      }
      const hermesHome = resolveHermesHome(agent.adapterConfig);
      await writeRoots(hermesHome, roots);
      ctx.logger.info("Updated Hermes write roots", {
        agentId: agent.id,
        hermesHome,
        rootCount: roots.length,
      });
      return { agentId: agent.id, hermesHome, roots };
    });
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
