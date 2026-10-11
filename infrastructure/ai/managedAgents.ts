import type { DiscoveredAgent, ExternalAgentConfig } from './types';
import { getCommandBasename, isPathLikeCommand } from './shared/pathLikeCommand';

export { isPathLikeCommand, getCommandBasename };

/**
 * Agent a new chat starts with. This build drives external CLI agents only —
 * the built-in "Catty" agent is no longer offered anywhere in the UI — so the
 * default is an external agent id and callers must resolve it like any other.
 */
export const DEFAULT_EXTERNAL_AGENT_ID = 'dsh';

/** The retired built-in agent id. Stored selections are migrated off it. */
export const LEGACY_BUILTIN_AGENT_ID = 'catty';

/**
 * Map a persisted agent selection onto a selectable agent id: the retired
 * built-in id (and an empty value) become the default external agent.
 */
export function migrateLegacyAgentSelection(agentId: string | null | undefined): string {
  const value = String(agentId ?? '').trim();
  if (!value || value === LEGACY_BUILTIN_AGENT_ID) return DEFAULT_EXTERNAL_AGENT_ID;
  return value;
}

export type ManagedAgentKey = 'codex' | 'claude' | 'copilot' | 'cursor' | 'codebuddy' | 'opencode' | 'grok' | 'mimo' | 'dsh' | 'hermes';

/** Every managed agent key, in the order the settings UI renders them. */
export const MANAGED_AGENT_KEYS = [
  'codex',
  'claude',
  'copilot',
  'cursor',
  'codebuddy',
  'opencode',
  'grok',
  'mimo',
  'dsh',
  'hermes',
] as const satisfies readonly ManagedAgentKey[];

const MANAGED_AGENT_META: Record<ManagedAgentKey, { commandNames: string[]; sdkBackend: string }> = {
  codex: { commandNames: ['codex'], sdkBackend: 'codex' },
  claude: { commandNames: ['claude'], sdkBackend: 'claude' },
  copilot: { commandNames: ['copilot'], sdkBackend: 'copilot' },
  cursor: { commandNames: ['cursor'], sdkBackend: 'cursor' },
  codebuddy: { commandNames: ['codebuddy'], sdkBackend: 'codebuddy' },
  opencode: { commandNames: ['opencode'], sdkBackend: 'opencode' },
  grok: { commandNames: ['grok'], sdkBackend: 'grok' },
  mimo: { commandNames: ['mimo'], sdkBackend: 'mimo' },
  dsh: { commandNames: ['dsh'], sdkBackend: 'dsh' },
  hermes: { commandNames: ['hermes'], sdkBackend: 'hermes' },
};

function matchesPrimaryCliBasename(command: string | undefined, agentKey: ManagedAgentKey): boolean {
  const basename = getCommandBasename(command);
  return basename === agentKey || basename.startsWith(`${agentKey}.`);
}

export function isSettingsManagedDiscoveredAgent(
  agent: Pick<DiscoveredAgent, 'command'>,
): agent is Pick<DiscoveredAgent, 'command'> & { command: ManagedAgentKey } {
  return agent.command === 'codex'
    || agent.command === 'claude'
    || agent.command === 'copilot'
    || agent.command === 'cursor'
    || agent.command === 'codebuddy'
    || agent.command === 'opencode'
    || agent.command === 'grok'
    || agent.command === 'mimo'
    || agent.command === 'dsh'
    || agent.command === 'hermes';
}

export function matchesManagedAgentConfig(
  agent: Pick<ExternalAgentConfig, 'id' | 'command' | 'sdkBackend' | 'acpCommand'>,
  agentKey: ManagedAgentKey,
): boolean {
  const meta = MANAGED_AGENT_META[agentKey];
  const basename = getCommandBasename(agent.command);
  if (agentKey === 'claude') {
    return (
      agent.id === 'discovered_claude' ||
      basename === 'claude' ||
      basename.startsWith('claude.')
    );
  }
  return (
    agent.id === `discovered_${agentKey}` ||
    getExternalAgentSdkBackend(agent) === meta.sdkBackend ||
    meta.commandNames.some((commandName) => basename === commandName || basename.startsWith(`${commandName}.`))
  );
}

export function getExternalAgentSdkBackend(
  agent: Pick<ExternalAgentConfig, 'sdkBackend' | 'acpCommand'> | undefined,
): string | undefined {
  return agent?.sdkBackend || agent?.acpCommand || undefined;
}

export function getManagedAgentStoredPath(
  agents: ExternalAgentConfig[],
  agentKey: ManagedAgentKey,
): string | null {
  const managedId = `discovered_${agentKey}`;
  const preferredAgent = agents.find(
    (agent) =>
      agent.id === managedId &&
      isPathLikeCommand(agent.command) &&
      matchesPrimaryCliBasename(agent.command, agentKey),
  );
  if (preferredAgent) {
    return preferredAgent.command;
  }

  const fallbackAgent = agents.find(
    (agent) =>
      matchesManagedAgentConfig(agent, agentKey) &&
      isPathLikeCommand(agent.command) &&
      matchesPrimaryCliBasename(agent.command, agentKey),
  );
  return fallbackAgent?.command ?? null;
}

export function getManualAgentCommand(
  config: Pick<ExternalAgentConfig, 'command' | 'commandSource'> | null | undefined,
): string | undefined {
  const command = String(config?.command || '').trim();
  return config?.commandSource === 'manual' && command ? command : undefined;
}
