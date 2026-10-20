import type { I18nContextValue } from '../i18n/I18nProvider';

/**
 * Translate system-panel failures the user cannot act on into something they can.
 *
 * Every system-panel tab runs its command over an auxiliary SSH exec channel, so
 * a stalled or fenced channel surfaces the same raw English message everywhere —
 * including "SSH exec channel open still pending on this connection", which used
 * to never clear on its own (see boundedSshExec's abandoned-open fence). Messages
 * that match nothing are passed through untouched.
 */
export function describeSystemManagerError(
  error: unknown,
  t: I18nContextValue['t'],
): string {
  const message = error == null
    ? ''
    : error instanceof Error
      ? error.message
      : String(error);
  // No message at all: callers keep their own fallback copy.
  if (!message) return '';
  const lower = message.toLowerCase();
  if (lower.includes('extra exec channels')) {
    return t('systemManager.unsupportedRemote');
  }
  if (
    lower.includes('still pending on this connection')
    || lower.includes('stopped answering exec channel')
  ) {
    return t('systemManager.errors.channelStalled');
  }
  if (lower.includes('channel open failure') || lower.includes('unable to exec')) {
    return t('systemManager.errors.sshChannelUnavailable');
  }
  return message;
}
