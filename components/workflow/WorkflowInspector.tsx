import React, { useMemo, useState } from 'react';
import { Copy, Trash2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Host } from '@/domain/models';
import type {
  ConditionOperator,
  NodeErrorPolicy,
  Workflow,
  WorkflowNode,
} from '@/domain/workflow/types.ts';
import { resolveNodeHosts } from '@/domain/workflow/validate.ts';

const ERROR_POLICIES: NodeErrorPolicy[] = ['stop', 'continue', 'errorPort'];
const CONDITION_OPERATORS: ConditionOperator[] = [
  'contains',
  'notContains',
  'equals',
  'notEquals',
  'regex',
  'truthy',
  'falsy',
];

const inputClass =
  'w-full rounded-md border border-border/60 bg-background px-2 py-1 text-xs outline-none focus:border-primary/60';

function Field({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

export interface WorkflowInspectorProps {
  workflow: Workflow;
  node: WorkflowNode;
  hosts: Host[];
  translate: (key: string, fallback: string) => string;
  onChange: (updater: (node: WorkflowNode) => WorkflowNode) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onClose: () => void;
}

export const WorkflowInspector: React.FC<WorkflowInspectorProps> = ({
  workflow,
  node,
  hosts,
  translate,
  onChange,
  onDelete,
  onDuplicate,
  onClose,
}) => {
  const [hostQuery, setHostQuery] = useState('');

  const resolvedHosts = useMemo(() => resolveNodeHosts(node, hosts), [node, hosts]);
  const filteredHosts = useMemo(() => {
    const query = hostQuery.trim().toLowerCase();
    if (!query) return hosts;
    return hosts.filter((host) => `${host.label} ${host.hostname}`.toLowerCase().includes(query));
  }, [hostQuery, hosts]);

  const patchConfig = (patch: Record<string, unknown>): void => {
    onChange((current) => ({ ...current, config: { ...current.config, ...patch } as WorkflowNode['config'] }));
  };

  const targets = node.config.kind === 'hostCommand' ? node.config.targets : null;

  return (
    <div className="flex w-[320px] shrink-0 flex-col border-l border-border/60" data-workflow-inspector>
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {translate('workflow.inspector.title', 'Node settings')}
        </span>
        <button type="button" onClick={onDuplicate} className="rounded p-1 hover:bg-accent" title={translate('workflow.action.duplicate', 'Duplicate')}>
          <Copy size={13} />
        </button>
        <button type="button" onClick={onDelete} className="rounded p-1 hover:bg-accent" title={translate('workflow.action.delete', 'Delete')}>
          <Trash2 size={13} className="text-destructive" />
        </button>
        <button type="button" onClick={onClose} className="rounded p-1 hover:bg-accent" title={translate('workflow.action.close', 'Close')}>
          <X size={13} />
        </button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        <Field label={translate('workflow.field.name', 'Name')}>
          <input
            className={inputClass}
            value={node.name}
            onChange={(event) => onChange((current) => ({ ...current, name: event.target.value }))}
          />
        </Field>

        {node.config.kind === 'hostCommand' && targets && (
          <>
            <Field label={translate('workflow.field.targets', 'Targets')}>
              <select
                className={inputClass}
                value={targets.mode}
                onChange={(event) => {
                  const mode = event.target.value as 'hosts' | 'groups' | 'all';
                  patchConfig({
                    targets: {
                      mode,
                      hostIds: targets.hostIds ?? [],
                      groupPaths: targets.groupPaths ?? [],
                    },
                  });
                }}
              >
                <option value="hosts">{translate('workflow.targets.hosts', 'Selected hosts')}</option>
                <option value="groups">{translate('workflow.targets.groups', 'Host groups')}</option>
                <option value="all">{translate('workflow.targets.all', 'All hosts')}</option>
              </select>
            </Field>

            {targets.mode === 'hosts' && (
              <div className="space-y-1">
                <input
                  className={inputClass}
                  placeholder={translate('workflow.field.hostSearch', 'Search hosts')}
                  value={hostQuery}
                  onChange={(event) => setHostQuery(event.target.value)}
                />
                <div className="max-h-40 overflow-y-auto rounded-md border border-border/60">
                  {filteredHosts.length === 0 && (
                    <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
                      {translate('workflow.field.noHosts', 'No matching host')}
                    </div>
                  )}
                  {filteredHosts.map((host) => {
                    const checked = (targets.hostIds ?? []).includes(host.id);
                    return (
                      <label
                        key={host.id}
                        className="flex cursor-pointer items-center gap-2 px-2 py-1 text-[11px] hover:bg-accent/50"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            const current = targets.hostIds ?? [];
                            patchConfig({
                              targets: {
                                ...targets,
                                hostIds: checked
                                  ? current.filter((id) => id !== host.id)
                                  : [...current, host.id],
                              },
                            });
                          }}
                        />
                        <span className="min-w-0 flex-1 truncate">{host.label || host.hostname}</span>
                        <span className="shrink-0 text-muted-foreground">{host.hostname}</span>
                      </label>
                    );
                  })}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {translate('workflow.field.resolvedHosts', 'Resolves to')}: {resolvedHosts.length}
                </div>
              </div>
            )}

            {targets.mode === 'groups' && (
              <Field label={translate('workflow.field.groupPaths', 'Group paths (one per line)')}>
                <textarea
                  className={cn(inputClass, 'h-16 font-mono')}
                  value={(targets.groupPaths ?? []).join('\n')}
                  onChange={(event) => patchConfig({
                    targets: {
                      ...targets,
                      groupPaths: event.target.value.split('\n').map((line) => line.trim()).filter(Boolean),
                    },
                  })}
                />
              </Field>
            )}

            <Field label={translate('workflow.field.command', 'Command')}>
              <textarea
                className={cn(inputClass, 'h-28 font-mono')}
                value={node.config.command}
                placeholder={'uptime\n{{ nodes.other.stdout | trim }}'}
                onChange={(event) => patchConfig({ command: event.target.value })}
              />
            </Field>

            <Field label={translate('workflow.field.expectedExitCodes', 'Expected exit codes')}>
              <input
                className={inputClass}
                value={(node.config.expectedExitCodes ?? [0]).join(', ')}
                onChange={(event) => {
                  const codes = event.target.value
                    .split(',')
                    .map((part) => Number(part.trim()))
                    .filter((value) => Number.isFinite(value));
                  patchConfig({ expectedExitCodes: codes });
                }}
              />
            </Field>

            <div className="grid grid-cols-2 gap-2">
              <Field label={translate('workflow.field.successPattern', 'Success pattern')}>
                <input
                  className={cn(inputClass, 'font-mono')}
                  value={node.config.successPattern ?? ''}
                  onChange={(event) => patchConfig({ successPattern: event.target.value || undefined })}
                />
              </Field>
              <Field label={translate('workflow.field.failurePattern', 'Failure pattern')}>
                <input
                  className={cn(inputClass, 'font-mono')}
                  value={node.config.failurePattern ?? ''}
                  onChange={(event) => patchConfig({ failurePattern: event.target.value || undefined })}
                />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Field label={translate('workflow.field.concurrency', 'Host concurrency')}>
                <input
                  type="number"
                  min={1}
                  className={inputClass}
                  value={node.config.concurrency ?? workflow.settings.concurrency}
                  onChange={(event) => patchConfig({ concurrency: Number(event.target.value) || undefined })}
                />
              </Field>
              <Field label={translate('workflow.field.failFast', 'Stop on first failure')}>
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4"
                  checked={node.config.failFast === true}
                  onChange={(event) => patchConfig({ failFast: event.target.checked || undefined })}
                />
              </Field>
            </div>

            <Field label={translate('workflow.field.requiresConfirm', 'Ask before running')}>
              <input
                type="checkbox"
                className="mt-1 h-4 w-4"
                checked={node.config.requiresConfirm === true}
                onChange={(event) => patchConfig({ requiresConfirm: event.target.checked || undefined })}
              />
            </Field>
          </>
        )}

        {node.config.kind === 'condition' && (
          <>
            <Field label={translate('workflow.field.left', 'Value')}>
              <input
                className={cn(inputClass, 'font-mono')}
                value={node.config.left}
                placeholder="{{ nodes.step.stdout }}"
                onChange={(event) => patchConfig({ left: event.target.value })}
              />
            </Field>
            <Field label={translate('workflow.field.operator', 'Operator')}>
              <select
                className={inputClass}
                value={node.config.operator}
                onChange={(event) => patchConfig({ operator: event.target.value })}
              >
                {CONDITION_OPERATORS.map((operator) => (
                  <option key={operator} value={operator}>
                    {translate(`workflow.operator.${operator}`, operator)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={translate('workflow.field.right', 'Compare with')}>
              <input
                className={cn(inputClass, 'font-mono')}
                value={node.config.right ?? ''}
                onChange={(event) => patchConfig({ right: event.target.value })}
              />
            </Field>
            <label className="flex items-center gap-2 text-[11px]">
              <input
                type="checkbox"
                checked={node.config.caseSensitive === true}
                onChange={(event) => patchConfig({ caseSensitive: event.target.checked || undefined })}
              />
              {translate('workflow.field.caseSensitive', 'Case sensitive')}
            </label>
          </>
        )}

        {node.config.kind === 'delay' && (
          <Field label={translate('workflow.field.delayMs', 'Wait (ms)')}>
            <input
              type="number"
              min={0}
              className={inputClass}
              value={node.config.ms}
              onChange={(event) => patchConfig({ ms: Number(event.target.value) || 0 })}
            />
          </Field>
        )}

        {node.config.kind === 'manual' && (
          <Field label={translate('workflow.field.manualMessage', 'Confirmation message')}>
            <input
              className={inputClass}
              value={node.config.message ?? ''}
              onChange={(event) => patchConfig({ message: event.target.value })}
            />
          </Field>
        )}

        <div className="space-y-2 border-t border-border/60 pt-3">
          <Field label={translate('workflow.field.onError', 'On failure')}>
            <select
              className={inputClass}
              value={node.onError ?? ''}
              onChange={(event) => onChange((current) => ({
                ...current,
                onError: (event.target.value || undefined) as NodeErrorPolicy | undefined,
              }))}
            >
              <option value="">{translate('workflow.onError.default', 'Workflow default')}</option>
              {ERROR_POLICIES.map((policy) => (
                <option key={policy} value={policy}>
                  {translate(`workflow.onError.${policy}`, policy)}
                </option>
              ))}
            </select>
          </Field>

          <div className="grid grid-cols-2 gap-2">
            <Field label={translate('workflow.field.retryAttempts', 'Retries')}>
              <input
                type="number"
                min={1}
                className={inputClass}
                value={node.retry?.maxAttempts ?? 1}
                onChange={(event) => {
                  const maxAttempts = Math.max(1, Number(event.target.value) || 1);
                  onChange((current) => ({
                    ...current,
                    retry: maxAttempts > 1
                      ? { maxAttempts, delayMs: current.retry?.delayMs ?? 1000 }
                      : undefined,
                  }));
                }}
              />
            </Field>
            <Field label={translate('workflow.field.retryDelay', 'Retry delay (ms)')}>
              <input
                type="number"
                min={0}
                className={inputClass}
                value={node.retry?.delayMs ?? 0}
                onChange={(event) => {
                  const delayMs = Math.max(0, Number(event.target.value) || 0);
                  onChange((current) => (current.retry
                    ? { ...current, retry: { ...current.retry, delayMs } }
                    : current));
                }}
              />
            </Field>
          </div>

          <Field label={translate('workflow.field.timeout', 'Timeout (ms)')}>
            <input
              type="number"
              min={1000}
              className={inputClass}
              value={node.timeoutMs ?? 60000}
              onChange={(event) => onChange((current) => ({
                ...current,
                timeoutMs: Number(event.target.value) || undefined,
              }))}
            />
          </Field>

          <label className="flex items-center gap-2 text-[11px]">
            <input
              type="checkbox"
              checked={node.disabled === true}
              onChange={(event) => onChange((current) => ({
                ...current,
                disabled: event.target.checked || undefined,
              }))}
            />
            {translate('workflow.field.disabled', 'Disabled (skip at run time)')}
          </label>
        </div>
      </div>
    </div>
  );
};

WorkflowInspector.displayName = 'WorkflowInspector';
