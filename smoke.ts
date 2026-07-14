// Standalone CLI harness that exercises the plugin worker logic against real
// Hermes profiles without needing a Paperclip host. This verifies read/write of
// file_access blocks to ~/.hermes/profiles/<profile>/config.yaml.

import {
  readProfileConfig,
  writeProfileConfig,
  scanFilesystem,
} from "./src/worker.ts";
import type { PermissionState, RouteContext, WorkerApi } from "./src/paperclip-types.ts";
import { createWorker } from "./src/worker.ts";

const PROFILES = ["ord-coordinator", "ord-analyst", "ord-engineer"];

function makeMockApi(agents: { id: string; name: string; adapterConfig?: Record<string, unknown> }[]): WorkerApi {
  const handlers: Record<string, (ctx: RouteContext) => Promise<unknown> | unknown> = {};
  return {
    onRoute(routeKey, handler) {
      handlers[routeKey] = handler;
    },
    async getAgents() {
      return agents.map(a => ({ ...a, companyId: "test" }));
    },
    async readState(_scope, _key, defaultValue) {
      return defaultValue as unknown;
    },
    async writeState() {
      return;
    },
    // expose for direct call
    _handlers: handlers as any,
  } as WorkerApi & { _handlers: typeof handlers };
}

async function main() {
  const agents = PROFILES.map((p) => ({
    id: `agent-${p}`,
    name: p,
    adapterConfig: { HERMES_PROFILE: p },
  }));

  const api = makeMockApi(agents);
  createWorker(api);

  console.log("=== 1. Read existing FAC for all 3 Ordillect profiles ===");
  for (const agent of agents) {
    const ctx: RouteContext = { params: { agentId: agent.id }, query: {}, body: undefined };
    const result = await (api as any)._handlers.getAgentFileAccess(ctx) as Awaited<ReturnType<typeof readProfileConfig>>;
    console.log(`${agent.name}:`, JSON.stringify(result, null, 2));
  }

  console.log("\n=== 2. Write FAC to ord-engineer ===");
  const paths: Record<string, PermissionState> = {
    "/home/kiddo/ordillect": "RW",
    "/home/kiddo/ordillect/.env": "D",
    "/tmp": "R",
  };
  const writeCtx: RouteContext = {
    params: { agentId: "agent-ord-engineer" },
    query: {},
    body: { paths },
  };
  const written = await (api as any)._handlers.setAgentFileAccess(writeCtx) as Awaited<ReturnType<typeof writeProfileConfig>>;
  console.log("Wrote:", JSON.stringify(written, null, 2));

  console.log("\n=== 3. Verify ord-engineer config.yaml contains file_access ===");
  const readCtx: RouteContext = { params: { agentId: "agent-ord-engineer" }, query: {}, body: undefined };
  const verify = await (api as any)._handlers.getAgentFileAccess(readCtx) as Awaited<ReturnType<typeof readProfileConfig>>;
  console.log("Read back:", JSON.stringify(verify, null, 2));

  console.log("\n=== 4. Scan /home/kiddo ===");
  const scanCtx: RouteContext = { params: {}, query: { root: "/home/kiddo" }, body: undefined };
  const scanned = await (api as any)._handlers.scanPath(scanCtx) as string[];
  console.log("Top-level entries:", scanned.slice(0, 20));

  console.log("\n=== 5. Revert ord-engineer to empty FAC ===");
  const emptyCtx: RouteContext = {
    params: { agentId: "agent-ord-engineer" },
    query: {},
    body: { paths: {} },
  };
  const reverted = await (api as any)._handlers.setAgentFileAccess(emptyCtx) as Awaited<ReturnType<typeof writeProfileConfig>>;
  console.log("Reverted:", JSON.stringify(reverted, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
