import type { ExternalAgentConfig } from "../../infrastructure/ai/types";
import { getExternalAgentSdkBackend } from "../../infrastructure/ai/managedAgents";

export function findEnabledExternalAgent(
  agents: ExternalAgentConfig[],
  agentId: string,
): ExternalAgentConfig | undefined {
  return agents.find((agent) =>
    agent.id === agentId &&
    agent.enabled &&
    agent.available !== false &&
    Boolean(getExternalAgentSdkBackend(agent)));
}

/**
 * The built-in Catty agent always runs in this app (it needs a configured
 * provider/model, which the composer gates separately); external agents must be
 * enabled and have a working SDK backend.
 */
export function canSendWithAgent(
  agentId: string,
  agents: ExternalAgentConfig[],
): boolean {
  return agentId === 'catty' || Boolean(findEnabledExternalAgent(agents, agentId));
}
