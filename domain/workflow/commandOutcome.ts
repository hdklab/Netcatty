/**
 * Success/failure decision for one host command, kept pure so the patterns and
 * exit-code rules are testable without SSH.
 */

import type { HostCommandNodeConfig } from './types.ts';

export interface CommandOutcomeInput {
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  /** Transport-level failure (connection refused, timeout, auth). */
  error?: string;
}

export interface CommandOutcome {
  ok: boolean;
  reason?: string;
}

export const DEFAULT_EXPECTED_EXIT_CODES = [0];

/**
 * `failurePattern` wins over everything: a command that prints a failure marker
 * fails even with exit code 0. `successPattern`, when set, replaces the
 * exit-code check entirely (some tools exit non-zero on success).
 */
export function evaluateCommandOutcome(
  config: Pick<HostCommandNodeConfig, 'expectedExitCodes' | 'successPattern' | 'failurePattern'>,
  input: CommandOutcomeInput,
): CommandOutcome {
  if (input.error) return { ok: false, reason: input.error };
  const stdout = input.stdout ?? '';

  if (config.failurePattern) {
    try {
      if (new RegExp(config.failurePattern).test(stdout)) {
        return { ok: false, reason: `Output matched failurePattern /${config.failurePattern}/` };
      }
    } catch {
      // An uncompilable pattern is reported by validation, not here.
    }
  }

  if (config.successPattern) {
    try {
      if (new RegExp(config.successPattern).test(stdout)) return { ok: true };
      return { ok: false, reason: `Output did not match successPattern /${config.successPattern}/` };
    } catch {
      return { ok: false, reason: 'successPattern is not a valid regular expression' };
    }
  }

  const expected = config.expectedExitCodes && config.expectedExitCodes.length > 0
    ? config.expectedExitCodes
    : DEFAULT_EXPECTED_EXIT_CODES;
  const code = typeof input.exitCode === 'number' ? input.exitCode : null;
  if (code === null) {
    // Session channels (telnet, serial, or a command typed into an open
    // terminal) have no exit status. Without patterns the command is taken as
    // successful; use successPattern/failurePattern to judge those hosts.
    return { ok: true };
  }
  if (expected.includes(code)) return { ok: true };
  return { ok: false, reason: `Exit code ${code} is not in [${expected.join(', ')}]` };
}
