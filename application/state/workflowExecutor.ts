/**
 * The real `WorkflowExecutor`.
 *
 * Per host it picks a channel (domain/workflow/channel.ts):
 *
 * - `exec`  — the one-off SSH exec channel (`netcatty:ssh:exec`) with the vault
 *   credential resolution the SFTP panes already use. Direct SSH hosts only.
 * - `session` — command typed into an already-open terminal, output read from
 *   the screen. Telnet/serial devices, mosh, and hosts behind a jump chain.
 *
 * The SSH exec channel has no abort channel of its own: cancellation is observed
 * by the runner, which stops scheduling; an issued command finishes on the wire.
 */

import type { Host, Identity, KnownHost, SSHKey, TerminalSettings } from '@/domain/models';
import type { WorkflowNode } from '@/domain/workflow/types.ts';
import { resolveExecutionChannel } from '@/domain/workflow/channel.ts';
import { netcattyBridge } from '@/infrastructure/services/netcattyBridge.ts';
import { captureScreenSnapshot } from '@/infrastructure/scripts/screenSnapshotRegistry.ts';
import { buildSftpHostCredentials } from './sftp/useSftpHostCredentials.ts';
import {
  findSessionForHost,
  runCommandInSession,
  type WorkflowSessionRef,
} from './workflowSessionExecutor.ts';
import type {
  WorkflowCommandRequest,
  WorkflowCommandResult,
  WorkflowExecutor,
} from './workflowRunner.ts';

export interface WorkflowExecutorDeps {
  hosts: Host[];
  keys: SSHKey[];
  identities: Identity[];
  knownHosts?: KnownHost[];
  terminalSettings?: Pick<TerminalSettings, 'verifyHostKeys' | 'keepaliveInterval' | 'keepaliveCountMax'>;
  /** Open terminal sessions, used for the session channel. */
  sessions?: readonly WorkflowSessionRef[];
  confirm?: (request: { node: WorkflowNode; message: string }) => Promise<boolean>;
  /** Injectable for tests; defaults to the real bridge call. */
  execCommand?: (
    options: Parameters<NonNullable<NetcattyBridge['execCommand']>>[0],
  ) => Promise<{ stdout: string; stderr: string; code: number | null }>;
  writeToSession?: (sessionId: string, data: string, options?: { automated?: boolean }) => void;
  captureSnapshot?: (sessionId: string) => { lines: string[] };
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(new Error('Cancelled'));
      return;
    }
    signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true });
  });
}

async function runViaExec(
  request: WorkflowCommandRequest,
  deps: WorkflowExecutorDeps,
): Promise<WorkflowCommandResult> {
  const exec = deps.execCommand
    ?? (async (options: Parameters<NonNullable<NetcattyBridge['execCommand']>>[0]) => {
      const bridge = netcattyBridge.get();
      if (!bridge?.execCommand) throw new Error('SSH exec bridge unavailable');
      return bridge.execCommand(options);
    });

  const credentials = buildSftpHostCredentials({
    host: request.host,
    hosts: deps.hosts,
    keys: deps.keys,
    identities: deps.identities,
    knownHosts: deps.knownHosts,
    terminalSettings: deps.terminalSettings,
  });

  const call = exec({
    hostname: credentials.hostname,
    hostId: credentials.hostId,
    username: credentials.username,
    port: credentials.port,
    authMethod: credentials.authMethod,
    requiresMfa: credentials.requiresMfa,
    password: credentials.password,
    privateKey: credentials.privateKey,
    certificate: credentials.certificate,
    publicKey: credentials.publicKey,
    keyId: credentials.keyId,
    keySource: credentials.keySource,
    passphrase: credentials.passphrase,
    identityFilePaths: credentials.identityFilePaths,
    useSshAgent: credentials.useSshAgent,
    agentPublicKeys: credentials.agentPublicKeys,
    identityAgent: credentials.identityAgent,
    identitiesOnly: credentials.identitiesOnly,
    addKeysToAgent: credentials.addKeysToAgent,
    useKeychain: credentials.useKeychain,
    legacyAlgorithms: credentials.legacyAlgorithms,
    skipEcdsaHostKey: credentials.skipEcdsaHostKey,
    algorithmOverrides: credentials.algorithmOverrides,
    sshTcpConnectTimeoutMs: credentials.sshTcpConnectTimeoutMs,
    sshAuthReadyTimeoutMs: credentials.sshAuthReadyTimeoutMs,
    enableKeyboardInteractive: true,
    command: request.command,
    timeout: request.timeoutMs,
    sessionId: `workflow:${request.host.id}`,
  });

  const result = await Promise.race([call, abortPromise(request.signal)]);
  return {
    exitCode: result.code ?? null,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export async function runCommandOnHost(
  request: WorkflowCommandRequest,
  deps: WorkflowExecutorDeps,
): Promise<WorkflowCommandResult> {
  const sessions = deps.sessions ?? [];
  const session = findSessionForHost(sessions, request.host.id);
  const channel = resolveExecutionChannel({ host: request.host, hasOpenSession: Boolean(session) });

  if (channel === 'exec') return runViaExec(request, deps);

  if (channel === 'session' && session) {
    const writeToSession = deps.writeToSession ?? ((sessionId, data, options) => {
      netcattyBridge.get()?.writeToSession?.(sessionId, data, options);
    });
    const result = await runCommandInSession(
      {
        hostId: request.host.id,
        command: request.command,
        timeoutMs: request.timeoutMs,
        signal: request.signal,
      },
      {
        sessions,
        writeToSession,
        captureSnapshot: deps.captureSnapshot ?? captureScreenSnapshot,
        sleep: (ms, signal) => new Promise<void>((resolve, reject) => {
          if (signal.aborted) {
            reject(new Error('Cancelled'));
            return;
          }
          const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          }, ms);
          const onAbort = () => {
            clearTimeout(timer);
            reject(new Error('Cancelled'));
          };
          signal.addEventListener('abort', onAbort, { once: true });
        }),
      },
    );
    if (!result.ok) return { error: result.error, stdout: result.stdout };
    return { exitCode: null, stdout: result.stdout ?? '', stderr: '' };
  }

  return {
    error: `${request.host.label || request.host.hostname} needs an open terminal session `
      + '(telnet / serial / mosh or a jump-chain host): open its terminal, then run again',
  };
}

export function createWorkflowExecutor(deps: WorkflowExecutorDeps): WorkflowExecutor {
  return {
    runCommand: (request) => runCommandOnHost(request, deps),
    sleep: (ms, signal) => new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('Cancelled'));
        return;
      }
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);
      const onAbort = () => {
        cleanup();
        reject(new Error('Cancelled'));
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }),
    confirm: deps.confirm,
  };
}
