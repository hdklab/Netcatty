/**
 * Reading a command's output out of a terminal screen snapshot.
 *
 * Session-mode execution (telnet devices, hosts behind a jump chain, or any
 * host whose terminal is already open) has no exec channel: we type the command
 * into the live session and read the visible screen. That makes extraction —
 * everything between the echoed command and the next prompt — pure text logic,
 * testable without a terminal.
 */

/** Strip ANSI escape sequences and carriage returns from a captured line. */
export function stripTerminalNoise(text: string): string {
  return String(text ?? '')
    // eslint-disable-next-line no-control-regex -- terminal escape sequences are control characters by definition
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '')
    .replace(/[ \t]+$/g, '');
}

/** Trailing shell/CLI prompt (root #, user $ / %, or device `>`). */
export const DEFAULT_PROMPT_TAIL_PATTERN = /[#$%>]\s*$/;

export function screenFingerprint(lines: readonly string[]): string {
  return lines.map(stripTerminalNoise).join('\n');
}

function isPromptLine(line: string, promptPattern: RegExp): boolean {
  return promptPattern.test(line.trim());
}

export interface ExtractCommandOutputParams {
  lines: readonly string[];
  command: string;
  /** Matches the trailing prompt of this host; defaults to `[#$%>]` endings. */
  promptPattern?: RegExp;
}

/**
 * Output of `command` as it currently appears on screen: text after the echoed
 * command line, with the trailing prompt removed. Empty when the echo is not
 * visible any more (scrolled off, or the command has not been typed yet).
 */
export function extractCommandOutput(params: ExtractCommandOutputParams): string {
  const promptPattern = params.promptPattern ?? DEFAULT_PROMPT_TAIL_PATTERN;
  const lines = params.lines.map(stripTerminalNoise);
  const needle = params.command.trim();
  if (needle.length === 0) return '';

  let echoIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]?.includes(needle)) {
      echoIndex = index;
      break;
    }
  }
  if (echoIndex === -1) return '';

  const output = lines.slice(echoIndex + 1);
  while (output.length > 0 && (output[output.length - 1] ?? '').trim() === '') {
    output.pop();
  }
  // The next prompt ends the response; drop that whole line. Command output
  // almost never ends in a prompt character, and keeping "switch#" would be
  // worse than the rare trailing `>` line being trimmed.
  if (output.length > 0 && isPromptLine(output[output.length - 1] as string, promptPattern)) {
    output.pop();
    while (output.length > 0 && (output[output.length - 1] ?? '').trim() === '') {
      output.pop();
    }
  }
  return output.join('\n').trim();
}

/** True when the command echo is already visible on screen. */
export function isCommandEchoVisible(lines: readonly string[], command: string): boolean {
  const needle = command.trim();
  if (needle.length === 0) return false;
  return lines.some((line) => stripTerminalNoise(line).includes(needle));
}
