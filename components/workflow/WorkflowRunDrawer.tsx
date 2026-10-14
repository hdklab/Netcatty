import React from 'react';
import { CheckCircle2, CircleSlash, Loader2, OctagonX, Timer, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { NodeRunResult, NodeRunStatus, Workflow, WorkflowRun } from '@/domain/workflow/types.ts';

function StatusIcon({ status }: { status: NodeRunStatus }): React.ReactElement {
  switch (status) {
    case 'running':
      return <Loader2 size={13} className="animate-spin text-primary" />;
    case 'waiting':
      return <Timer size={13} className="text-amber-500" />;
    case 'success':
      return <CheckCircle2 size={13} className="text-emerald-500" />;
    case 'failed':
      return <XCircle size={13} className="text-destructive" />;
    case 'skipped':
      return <CircleSlash size={13} className="text-muted-foreground" />;
    default:
      return <span className="inline-block h-3 w-3 rounded-full border border-border" />;
  }
}

function formatDuration(startedAt?: number, endedAt?: number): string {
  if (!startedAt || !endedAt) return '';
  const ms = Math.max(0, endedAt - startedAt);
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function formatTime(value?: number): string {
  if (!value) return '';
  const date = new Date(value);
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
}

export interface WorkflowRunDrawerProps {
  workflow: Workflow;
  run: WorkflowRun | null;
  history: readonly WorkflowRun[];
  selectedRunId: string | null;
  onSelectRun: (runId: string | null) => void;
  onClearHistory: () => void;
  translate: (key: string, fallback: string) => string;
}

export const WorkflowRunDrawer: React.FC<WorkflowRunDrawerProps> = ({
  workflow,
  run,
  history,
  selectedRunId,
  onSelectRun,
  onClearHistory,
  translate,
}) => {
  const nodeName = (nodeId: string): string =>
    workflow.nodes.find((node) => node.id === nodeId)?.name ?? nodeId;

  const runForWorkflow = history.filter((entry) => entry.workflowId === workflow.id);

  return (
    <div className="flex h-[240px] shrink-0 flex-col border-t border-border/60" data-workflow-run-drawer>
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2">
        <span className="text-xs font-medium">{translate('workflow.run.title', 'Run')}</span>
        {run ? (
          <span
            className={cn(
              'rounded px-1.5 py-0.5 text-[10px] uppercase',
              run.status === 'running' && 'bg-primary/15 text-primary',
              run.status === 'success' && 'bg-emerald-500/15 text-emerald-600',
              run.status === 'failed' && 'bg-destructive/15 text-destructive',
              run.status === 'cancelled' && 'bg-muted text-muted-foreground',
            )}
          >
            {translate(`workflow.run.status.${run.status}`, run.status)}
          </span>
        ) : (
          <span className="text-[11px] text-muted-foreground">
            {translate('workflow.run.empty', 'No run yet')}
          </span>
        )}
        {run?.endedAt && (
          <span className="text-[11px] text-muted-foreground">
            {formatDuration(run.startedAt, run.endedAt)} · {formatTime(run.startedAt)}
          </span>
        )}
        <div className="flex-1" />
        <select
          className="rounded-md border border-border/60 bg-background px-1.5 py-1 text-[11px]"
          value={selectedRunId ?? ''}
          onChange={(event) => onSelectRun(event.target.value || null)}
          title={translate('workflow.run.history', 'Run history')}
        >
          <option value="">
            {translate('workflow.run.latest', 'Latest run')}
          </option>
          {runForWorkflow.map((entry) => (
            <option key={entry.runId} value={entry.runId}>
              {`${entry.status} · ${formatTime(entry.startedAt)}`}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="rounded px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-accent"
          onClick={onClearHistory}
        >
          {translate('workflow.run.clearHistory', 'Clear history')}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {!run && (
          <div className="p-4 text-center text-[11px] text-muted-foreground">
            {translate('workflow.run.hint', 'Press Run to execute this workflow.')}
          </div>
        )}
        {run && (
          <>
            <div className="divide-y divide-border/40">
              {workflow.nodes.map((node) => {
                const result: NodeRunResult | undefined = run.nodeRuns[node.id];
                const status: NodeRunStatus = result?.status ?? 'pending';
                const failures = result?.hosts.filter((host) => !host.ok) ?? [];
                return (
                  <details key={node.id} className="group">
                    <summary className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[11px] hover:bg-accent/40">
                      <StatusIcon status={status} />
                      <span className="min-w-0 flex-1 truncate">{node.name}</span>
                      <span className="shrink-0 text-muted-foreground">
                        {result?.hosts.length ? `${result.hosts.length} host(s)` : ''}
                      </span>
                      <span className="shrink-0 text-muted-foreground">
                        {formatDuration(result?.startedAt, result?.endedAt)}
                      </span>
                      {failures.length > 0 && (
                        <span className="shrink-0 text-destructive">{failures.length} failed</span>
                      )}
                    </summary>
                    <div className="space-y-2 bg-accent/20 px-4 py-2">
                      {result?.error && (
                        <div className="font-mono text-[11px] text-destructive">{result.error}</div>
                      )}
                      {result?.detail && (
                        <div className="font-mono text-[11px] text-muted-foreground">{result.detail}</div>
                      )}
                      {result?.skippedReason && (
                        <div className="text-[11px] text-muted-foreground">
                          {translate('workflow.run.skippedBecause', 'Skipped because')}: {result.skippedReason}
                        </div>
                      )}
                      {result?.hosts.map((host) => (
                        <div key={host.hostId} className="space-y-1">
                          <div className="flex items-center gap-2 text-[11px]">
                            <span className={host.ok ? 'text-emerald-600' : 'text-destructive'}>
                              {host.hostLabel}
                            </span>
                            <span className="text-muted-foreground">
                              {host.exitCode === undefined ? '' : `exit ${host.exitCode}`}
                            </span>
                            <span className="text-muted-foreground">
                              {host.attempts > 1 ? `${host.attempts} attempts` : ''}
                            </span>
                            {host.error && <span className="text-destructive">{host.error}</span>}
                          </div>
                          {host.stdout && (
                            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-background/70 p-2 font-mono text-[10px]">
                              {host.stdout}
                            </pre>
                          )}
                          {host.stderr && (
                            <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all rounded bg-destructive/10 p-2 font-mono text-[10px] text-destructive">
                              {host.stderr}
                            </pre>
                          )}
                        </div>
                      ))}
                    </div>
                  </details>
                );
              })}
            </div>

            <div className="border-t border-border/40 p-3">
              <div className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                <OctagonX size={11} />
                {translate('workflow.run.log', 'Log')}
              </div>
              <div className="max-h-32 space-y-0.5 overflow-y-auto font-mono text-[10px]">
                {run.log.map((entry, index) => (
                  <div
                    key={`${entry.at}-${index}`}
                    className={cn(
                      'truncate',
                      entry.level === 'error' && 'text-destructive',
                      entry.level === 'warn' && 'text-amber-600',
                      entry.level === 'info' && 'text-muted-foreground',
                    )}
                    title={entry.message}
                  >
                    {nodeName(entry.nodeId ?? '')} {entry.message}
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

WorkflowRunDrawer.displayName = 'WorkflowRunDrawer';
