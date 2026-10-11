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
 * Only enabled external agents can run a turn. The built-in Catty agent is not
 * offered by this build, so a leftover "catty" selection is not sendable — the
 * panel migrates such selections to the default external agent before sending.
 */
export function canSendWithAgent(
  agentId: string,
  agents: ExternalAgentConfig[],
): boolean {
  return Boolean(findEnabledExternalAgent(agents, agentId));
}
