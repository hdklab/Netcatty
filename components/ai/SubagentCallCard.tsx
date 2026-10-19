/**
 * SubagentCallCard - Collapsible card for a `run_subagent` tool call.
 *
 * The parent agent sees one report string; this card surfaces the delegation
 * (label, read-only badge, running/done/failed state, elapsed time) and renders
 * the report as markdown. Everything else about tool rendering is unchanged.
 */

import {
  AlertCircle,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Lock,
} from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { cn } from '../../lib/utils';
import { LazyMessageResponse } from '../ai-elements/LazyMessageResponse';

export type SubagentCallStatus = 'running' | 'done' | 'failed';

export interface SubagentCallCardProps {
  /** Tool-call arguments: `{ prompt, description, allowWrites? }`. */
  args?: Record<string, unknown>;
  /** Raw tool-result content (JSON from the tool, or a plain report string). */
  result?: string;
  isError?: boolean;
  /** Overrides the state derived from `result`. */
  status?: SubagentCallStatus;
  className?: string;
}

type SubagentResultPayload = {
  report?: string;
  steps?: number;
  elapsedMs?: number;
  error?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function parseSubagentResult(result: string | undefined): SubagentResultPayload | null {
  if (result === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(result);
    if (isRecord(parsed)) {
      return {
        report: typeof parsed.report === 'string' ? parsed.report : undefined,
        steps: typeof parsed.steps === 'number' ? parsed.steps : undefined,
        elapsedMs: typeof parsed.elapsedMs === 'number' ? parsed.elapsedMs : undefined,
        error: typeof parsed.error === 'string' ? parsed.error : undefined,
      };
    }
  } catch {
    // Not JSON: the tool result is the report itself.
  }
  return { report: result };
}

export function resolveSubagentStatus(
  result: string | undefined,
  isError: boolean | undefined,
  override: SubagentCallStatus | undefined,
): SubagentCallStatus {
  if (override) return override;
  if (result === undefined) return 'running';
  const parsed = parseSubagentResult(result);
  if (isError || parsed?.error) return 'failed';
  return 'done';
}

export function formatSubagentElapsed(elapsedMs: number | undefined): string | null {
  if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs < 0) return null;
  if (elapsedMs < 1_000) return `${Math.round(elapsedMs)} ms`;
  return `${(elapsedMs / 1_000).toFixed(1)} s`;
}

function readString(args: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = args?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

const STATUS_ICON: Record<SubagentCallStatus, React.ReactNode> = {
  running: <Loader2 size={12} className="shrink-0 animate-spin text-muted-foreground" />,
  done: <CheckCircle2 size={12} className="shrink-0 text-emerald-500" />,
  failed: <AlertCircle size={12} className="shrink-0 text-destructive" />,
};

const STATUS_LABEL_KEY: Record<SubagentCallStatus, string> = {
  running: 'ai.subagent.running',
  done: 'ai.subagent.done',
  failed: 'ai.subagent.failed',
};

const SubagentCallCard: React.FC<SubagentCallCardProps> = ({
  args,
  result,
  isError,
  status: statusOverride,
  className,
}) => {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(true);
  const status = resolveSubagentStatus(result, isError, statusOverride);
  const parsed = useMemo(() => parseSubagentResult(result), [result]);
  const description = readString(args, 'description')
    ?? readString(args, 'goal')
    ?? readString(args, 'task');
  const prompt = readString(args, 'prompt')
    ?? readString(args, 'message')
    ?? readString(args, 'context');
  const elapsed = formatSubagentElapsed(parsed?.elapsedMs);
  const report = parsed?.report?.trim() ?? '';
  const errorMessage = parsed?.error?.trim() ?? '';

  return (
    <div
      data-subagent-card={status}
      className={cn(
        'min-w-0 overflow-hidden rounded-md border border-border/30 bg-muted/10',
        status === 'failed' && 'border-destructive/30',
        className,
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-muted/20 select-none cursor-pointer"
        aria-expanded={expanded}
      >
        {expanded
          ? <ChevronDown size={12} className="shrink-0 text-muted-foreground/50" />
          : <ChevronRight size={12} className="shrink-0 text-muted-foreground/50" />}
        <Bot size={13} className="shrink-0 text-muted-foreground/80" />
        <span className="shrink-0 font-medium text-muted-foreground/80">
          {t('ai.subagent.title')}
        </span>
        {description && (
          <span className="min-w-0 truncate text-foreground/70">{description}</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded border border-border/40 bg-muted/30 px-1.5 py-0.5 text-[10px] text-muted-foreground">
            <Lock size={9} />
            {t('ai.subagent.readonly')}
          </span>
          <span
            className={cn(
              'inline-flex items-center gap-1',
              status === 'failed' ? 'text-destructive' : 'text-muted-foreground/80',
            )}
          >
            {STATUS_ICON[status]}
            {t(STATUS_LABEL_KEY[status])}
          </span>
          {elapsed && <span className="tabular-nums text-muted-foreground/60">{elapsed}</span>}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border/20 px-3 py-2">
          {status === 'running' ? (
            prompt
              ? <p className="line-clamp-2 text-[11px] text-muted-foreground/70">{prompt}</p>
              : <span className="thinking-shimmer text-[12px]">{t('ai.subagent.running')}</span>
          ) : status === 'failed' ? (
            <p className="whitespace-pre-wrap break-words text-[12px] text-destructive [overflow-wrap:anywhere]">
              {errorMessage || t('ai.subagent.failed')}
            </p>
          ) : report ? (
            <div data-ai-content="markdown" className="text-[12px] leading-relaxed">
              <LazyMessageResponse>{report}</LazyMessageResponse>
            </div>
          ) : (
            <p className="text-[12px] text-muted-foreground">{t('ai.subagent.done')}</p>
          )}
          {parsed?.steps !== undefined && status !== 'running' && (
            <p className="mt-1.5 text-[10px] text-muted-foreground/50">
              {parsed.steps} step{parsed.steps === 1 ? '' : 's'}
            </p>
          )}
        </div>
      )}
    </div>
  );
};

export default SubagentCallCard;
