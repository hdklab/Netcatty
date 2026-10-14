/**
 * Which channel executes a workflow node's command on a host.
 *
 * `exec` is the one-off SSH exec channel (`netcatty:ssh:exec`): clean, silent,
 * no open terminal needed, direct connections only. Everything else — telnet
 * and serial devices, mosh/et transports, hosts behind a jump chain — has no
 * exec channel and must go through an already-open terminal session.
 */

import type { Host } from '../models';
import { resolveEffectiveTerminalProtocol } from '../terminalProtocol.ts';

export type ExecutionChannel = 'exec' | 'session' | 'unavailable';

export type ChannelHost = Pick<Host, 'protocol' | 'hostChain' | 'moshEnabled' | 'etEnabled' | 'hostname'>;

export function resolveExecutionChannel(params: {
  host: ChannelHost;
  hasOpenSession: boolean;
}): ExecutionChannel {
  const { host, hasOpenSession } = params;
  const protocol = resolveEffectiveTerminalProtocol(host);
  const behindJumpChain = (host.hostChain?.hostIds ?? []).length > 0;

  if (protocol === 'ssh' && !behindJumpChain) return 'exec';
  return hasOpenSession ? 'session' : 'unavailable';
}
