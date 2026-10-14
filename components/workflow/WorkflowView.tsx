import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  AlertTriangle,
  Copy,
  Loader2,
  Plus,
  Play,
  Redo2,
  Square,
  Trash2,
  Undo2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/application/i18n/I18nProvider';
import type { Host, Identity, KnownHost, SSHKey, TerminalSettings } from '@/domain/models';
import { createWorkflowNode, nextNodeName } from '@/domain/workflow/nodeCatalog.ts';
import {
  DEFAULT_MAX_LOOP_ITERATIONS,
  type Workflow,
  type WorkflowNode,
  type WorkflowNodeKind,
  type WorkflowOutputPort,
} from '@/domain/workflow/types.ts';
import { validateWorkflow, type WorkflowIssue } from '@/domain/workflow/validate.ts';
import { workflowEditorStore, useWorkflowEditorState } from '@/application/state/workflowEditorStore.ts';
import { readCommandBlocklistSetting } from '@/application/state/commandBlocklistSettings.ts';
import { useWorkflowRunHistory, useActiveWorkflowRun, workflowRunStore } from '@/application/state/workflowRunStore.ts';
import { useWorkflows, workflowStore } from '@/application/state/workflowStore.ts';
import { useWorkflowRunner } from '@/application/state/useWorkflowRunner.ts';
import { WorkflowCanvas } from './WorkflowCanvas.tsx';
import { WorkflowInspector } from './WorkflowInspector.tsx';
import { WorkflowPalette } from './WorkflowPalette.tsx';
import { WorkflowRunDrawer } from './WorkflowRunDrawer.tsx';

export interface WorkflowViewProps {
  hosts: Host[];
  keys: SSHKey[];
  identities: Identity[];
  knownHosts?: KnownHost[];
  terminalSettings?: Pick<TerminalSettings, 'verifyHostKeys' | 'keepaliveInterval' | 'keepaliveCountMax'>;
  /** Open terminal sessions; telnet/serial/jump-chain hosts run inside theirs. */
  sessions?: ReadonlyArray<{ id: string; hostId?: string }>;
  /** Destructive-command patterns from AI settings. */
  blockedPatterns?: readonly string[];
}

interface ConfirmRequest {
  title: string;
  message: string;
  resolve: (approved: boolean) => void;
}

export const WorkflowView: React.FC<WorkflowViewProps> = ({
  hosts,
  keys,
  identities,
  knownHosts,
  terminalSettings,
  sessions,
  blockedPatterns,
}) => {
  const { t } = useI18n();
  const translate = useCallback((key: string, fallback: string): string => {
    const value = t(key);
    return value === key ? fallback : value;
  }, [t]);

  const workflows = useWorkflows();
  const editorState = useWorkflowEditorState();
  const activeRun = useActiveWorkflowRun();
  const runHistory = useWorkflowRunHistory();

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [issuesBanner, setIssuesBanner] = useState<readonly WorkflowIssue[] | null>(null);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);

  const workflow = workflows.find((entry) => entry.id === editorState.workflowId) ?? null;
  const selectedNode = workflow?.nodes.find((node) => node.id === editorState.selectedNodeId) ?? null;

  // Callers may pass the AI blocklist explicitly; otherwise read the user's setting.
  const effectiveBlockedPatterns = useMemo(
    () => blockedPatterns ?? readCommandBlocklistSetting(),
    [blockedPatterns],
  );

  const issues = useMemo(
    () => (workflow ? validateWorkflow(workflow, { hosts, blockedPatterns: effectiveBlockedPatterns }) : []),
    [workflow, hosts, effectiveBlockedPatterns],
  );
  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  const warningCount = issues.length - errorCount;

  const confirm = useCallback(
    (request: { node: WorkflowNode; message: string }): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        setConfirmRequest({ title: request.node.name, message: request.message, resolve });
      }),
    [],
  );

  const runner = useWorkflowRunner({
    hosts,
    keys,
    identities,
    knownHosts,
    terminalSettings,
    sessions,
    blockedPatterns: effectiveBlockedPatterns,
    confirm,
  });

  const edit = useCallback((updater: (current: Workflow) => Workflow): void => {
    workflowEditorStore.edit(updater);
  }, []);

  const addNode = useCallback((kind: WorkflowNodeKind, position: { x: number; y: number }): void => {
    edit((current) => {
      const node = createWorkflowNode({
        kind,
        id: crypto.randomUUID(),
        name: nextNodeName(current, kind),
        position,
      });
      if (!node) return current;
      return { ...current, nodes: [...current.nodes, node] };
    });
  }, [edit]);

  const addNodeAtCenterRef = useRef<((kind: WorkflowNodeKind) => void) | null>(null);
  const registerAddNodeAtCenter = useCallback((add: ((kind: WorkflowNodeKind) => void) | null): void => {
    addNodeAtCenterRef.current = add;
  }, []);
  const addNodeFromPalette = useCallback((kind: WorkflowNodeKind): void => {
    if (addNodeAtCenterRef.current) {
      addNodeAtCenterRef.current(kind);
      return;
    }
    addNode(kind, { x: 120, y: 120 });
  }, [addNode]);

  const connectNodes = useCallback((params: {
    from: { nodeId: string; output: WorkflowOutputPort };
    to: { nodeId: string };
  }): void => {
    edit((current) => {
      const duplicate = current.edges.some((edge) => (
        edge.from.nodeId === params.from.nodeId
        && edge.from.output === params.from.output
        && edge.to.nodeId === params.to.nodeId
      ));
      if (duplicate) return current;
      return {
        ...current,
        edges: [
          ...current.edges,
          {
            id: crypto.randomUUID(),
            from: params.from,
            to: { nodeId: params.to.nodeId, input: 'main' },
          },
        ],
      };
    });
  }, [edit]);

  const moveNode = useCallback((nodeId: string, position: { x: number; y: number }): void => {
    edit((current) => ({
      ...current,
      nodes: current.nodes.map((node) => (node.id === nodeId ? { ...node, position } : node)),
    }));
  }, [edit]);

  const updateNode = useCallback((nodeId: string, updater: (node: WorkflowNode) => WorkflowNode): void => {
    edit((current) => ({
      ...current,
      nodes: current.nodes.map((node) => (node.id === nodeId ? updater(node) : node)),
    }));
  }, [edit]);

  const deleteEdges = useCallback((edgeIds: readonly string[]): void => {
    if (edgeIds.length === 0) return;
    edit((current) => ({
      ...current,
      edges: current.edges.filter((edge) => !edgeIds.includes(edge.id)),
    }));
  }, [edit]);

  /** Moving a connection's endpoint: drop any duplicate created by the move. */
  const reconnectEdge = useCallback((edgeId: string, params: {
    from: { nodeId: string; output: WorkflowOutputPort };
    to: { nodeId: string };
  }): void => {
    edit((current) => {
      const existing = current.edges.find((edge) => edge.id === edgeId);
      if (!existing) return current;
      const others = current.edges.filter((edge) => (
        edge.id !== edgeId
        && !(edge.from.nodeId === params.from.nodeId
          && edge.from.output === params.from.output
          && edge.to.nodeId === params.to.nodeId)
      ));
      return {
        ...current,
        edges: [
          ...others,
          { ...existing, from: params.from, to: { nodeId: params.to.nodeId, input: 'main' } },
        ],
      };
    });
  }, [edit]);

  const deleteNodes = useCallback((nodeIds: readonly string[]): void => {
    if (nodeIds.length === 0) return;
    edit((current) => ({
      ...current,
      nodes: current.nodes.filter((node) => !nodeIds.includes(node.id)),
      edges: current.edges.filter((edge) => (
        !nodeIds.includes(edge.from.nodeId) && !nodeIds.includes(edge.to.nodeId)
      )),
    }));
    if (editorState.selectedNodeId && nodeIds.includes(editorState.selectedNodeId)) {
      workflowEditorStore.selectNode(null);
    }
  }, [edit, editorState.selectedNodeId]);

  const duplicateNode = useCallback((node: WorkflowNode): void => {
    edit((current) => {
      const copy: WorkflowNode = {
        ...structuredClone(node),
        id: crypto.randomUUID(),
        name: nextNodeName(current, node.kind),
        position: { x: node.position.x + 40, y: node.position.y + 40 },
      };
      return { ...current, nodes: [...current.nodes, copy] };
    });
    workflowEditorStore.selectNode(null);
  }, [edit]);

  const handleRun = useCallback(async (): Promise<void> => {
    if (!workflow || runner.running) return;
    setSelectedRunId(null);
    const attempt = await runner.run(workflow);
    setIssuesBanner(attempt.ok ? null : attempt.issues);
  }, [workflow, runner]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const isModifier = event.metaKey || event.ctrlKey;
      if (!isModifier) return;
      const key = event.key.toLowerCase();
      if (key === 'z') {
        event.preventDefault();
        if (event.shiftKey) workflowEditorStore.redo();
        else workflowEditorStore.undo();
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        void handleRun();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleRun]);

  const activeRunForWorkflow = activeRun && workflow && activeRun.workflowId === workflow.id ? activeRun : null;
  const selectedRun = selectedRunId
    ? runHistory.find((entry) => entry.runId === selectedRunId) ?? null
    : null;
  const displayedRun = activeRunForWorkflow
    ?? selectedRun
    ?? (workflow ? runHistory.find((entry) => entry.workflowId === workflow.id) ?? null : null);

  const createWorkflow = useCallback((): void => {
    const created = workflowStore.create(translate('workflow.defaultName', 'New workflow'));
    workflowEditorStore.open(created.id);
  }, [translate]);

  const resolveConfirm = useCallback((approved: boolean): void => {
    confirmRequest?.resolve(approved);
    setConfirmRequest(null);
  }, [confirmRequest]);

  return (
    <div className="flex h-full min-h-0 w-full bg-background" data-workflow-view>
      <aside className="flex w-[240px] shrink-0 flex-col border-r border-border/60">
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2">
          <span className="flex-1 text-xs font-medium">{translate('workflow.title', 'Workflows')}</span>
          <button
            type="button"
            className="rounded p-1 hover:bg-accent"
            onClick={createWorkflow}
            data-workflow-action="new"
            title={translate('workflow.action.new', 'New workflow')}
          >
            <Plus size={14} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2" data-workflow-list>
          {workflows.length === 0 && (
            <div className="p-2 text-[11px] leading-relaxed text-muted-foreground">
              {translate('workflow.list.empty', 'No workflow yet. Create one and drag nodes onto the canvas.')}
            </div>
          )}
          {workflows.map((entry) => {
            const isOpen = entry.id === editorState.workflowId;
            return (
              <div
                key={entry.id}
                data-workflow-item={entry.id}
                className={cn(
                  'group flex items-center gap-1 rounded-md px-2 py-1.5 text-xs',
                  isOpen ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
                )}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left"
                  onClick={() => {
                    workflowEditorStore.open(entry.id);
                    setSelectedRunId(null);
                    setIssuesBanner(null);
                  }}
                  title={entry.name}
                >
                  {entry.name}
                  <span className="ml-1 text-[10px] text-muted-foreground">{entry.nodes.length}</span>
                </button>
                <button
                  type="button"
                  className="rounded p-1 opacity-0 hover:bg-accent group-hover:opacity-100"
                  title={translate('workflow.action.duplicate', 'Duplicate')}
                  onClick={() => workflowStore.duplicate(entry.id)}
                >
                  <Copy size={12} />
                </button>
                <button
                  type="button"
                  className="rounded p-1 opacity-0 hover:bg-accent group-hover:opacity-100"
                  title={translate('workflow.action.delete', 'Delete')}
                  onClick={() => {
                    workflowStore.remove(entry.id);
                    workflowRunStore.clearHistory(entry.id);
                    if (isOpen) workflowEditorStore.close();
                  }}
                >
                  <Trash2 size={12} className="text-destructive" />
                </button>
              </div>
            );
          })}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {!workflow && (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
            <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
              {translate(
                'workflow.emptyState',
                'Build a graph of steps across your hosts: add a node, pick its hosts, wire dependencies, then run it.',
              )}
            </p>
            <button
              type="button"
              className="rounded-md border border-border/60 px-3 py-1.5 text-xs hover:bg-accent"
              onClick={createWorkflow}
            >
              {translate('workflow.action.new', 'New workflow')}
            </button>
          </div>
        )}

        {workflow && (
          <>
            <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2">
              <input
                className="min-w-0 max-w-[280px] flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-xs outline-none hover:border-border/60 focus:border-primary/60"
                value={workflow.name}
                onChange={(event) => edit((current) => ({ ...current, name: event.target.value }))}
              />
              <span className="text-[11px] text-muted-foreground">
                {workflow.nodes.length} {translate('workflow.stat.nodes', 'nodes')} ·{' '}
                {translate('workflow.stat.autosaved', 'saved automatically')}
              </span>
              <label
                className="flex items-center gap-1 text-[11px] text-muted-foreground"
                title={translate(
                  'workflow.toolbar.loopLimitHint',
                  'How many times a failing node may restart the step it points back into',
                )}
              >
                {translate('workflow.toolbar.loopLimit', 'Loop limit')}
                <input
                  type="number"
                  min={1}
                  data-workflow-loop-limit
                  className="w-12 rounded border border-border/60 bg-background px-1 py-0.5 text-[11px]"
                  value={workflow.settings.maxLoopIterations ?? DEFAULT_MAX_LOOP_ITERATIONS}
                  onChange={(event) => {
                    const value = Math.max(
                      1,
                      Math.floor(Number(event.target.value)) || DEFAULT_MAX_LOOP_ITERATIONS,
                    );
                    edit((current) => ({
                      ...current,
                      settings: { ...current.settings, maxLoopIterations: value },
                    }));
                  }}
                />
              </label>
              <span
                className={cn(
                  'flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]',
                  errorCount > 0
                    ? 'bg-destructive/15 text-destructive'
                    : warningCount > 0
                      ? 'bg-amber-500/15 text-amber-600'
                      : 'bg-muted text-muted-foreground',
                )}
                title={issues.map((issue) => issue.message).join('\n')}
              >
                {errorCount > 0 || warningCount > 0 ? <AlertTriangle size={11} /> : null}
                {errorCount > 0
                  ? `${errorCount} ${translate('workflow.stat.errors', 'errors')}`
                  : warningCount > 0
                    ? `${warningCount} ${translate('workflow.stat.warnings', 'warnings')}`
                    : translate('workflow.stat.valid', 'Ready')}
              </span>
              <div className="flex-1" />
              <button
                type="button"
                className="rounded p-1 hover:bg-accent disabled:opacity-40"
                onClick={() => workflowEditorStore.undo()}
                disabled={editorState.past.length === 0}
                data-workflow-action="undo"
                title={translate('workflow.action.undo', 'Undo (Ctrl+Z)')}
              >
                <Undo2 size={14} />
              </button>
              <button
                type="button"
                className="rounded p-1 hover:bg-accent disabled:opacity-40"
                onClick={() => workflowEditorStore.redo()}
                disabled={editorState.future.length === 0}
                data-workflow-action="redo"
                title={translate('workflow.action.redo', 'Redo (Ctrl+Shift+Z)')}
              >
                <Redo2 size={14} />
              </button>
              {runner.running ? (
                <button
                  type="button"
                  className="flex items-center gap-1 rounded-md border border-border/60 px-2.5 py-1 text-xs hover:bg-accent"
                  onClick={() => runner.stop()}
                  data-workflow-action="stop"
                >
                  <Square size={12} />
                  {translate('workflow.action.stop', 'Stop')}
                </button>
              ) : (
                <button
                  type="button"
                  className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground hover:opacity-90"
                  onClick={() => void handleRun()}
                  data-workflow-action="run"
                >
                  <Play size={12} />
                  {translate('workflow.action.run', 'Run')}
                </button>
              )}
              {runner.running && <Loader2 size={13} className="animate-spin text-primary" />}
            </div>

            {issuesBanner && issuesBanner.length > 0 && (
              <div className="shrink-0 border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
                <div className="mb-1 font-medium">
                  {translate('workflow.banner.blocked', 'Fix these problems before running:')}
                </div>
                <ul className="list-inside list-disc space-y-0.5">
                  {issuesBanner.slice(0, 5).map((issue, index) => (
                    <li key={`${issue.code}-${index}`}>{issue.message}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex min-h-0 flex-1">
              <WorkflowPalette translate={translate} onAddNode={addNodeFromPalette} />
              <div className="min-w-0 flex-1">
                <WorkflowCanvas
                  workflow={workflow}
                  hosts={hosts}
                  run={displayedRun}
                  issues={issues}
                  translate={translate}
                  onSelectNode={(nodeId) => workflowEditorStore.selectNode(nodeId)}
                  onMoveNode={moveNode}
                  onConnectNodes={connectNodes}
                  onDeleteEdge={(edgeId) => deleteEdges([edgeId])}
                  onReconnectEdge={reconnectEdge}
                  onDeleteNodes={deleteNodes}
                  onAddNode={addNode}
                  registerAddNodeAtCenter={registerAddNodeAtCenter}
                />
              </div>
              {selectedNode && (
                <WorkflowInspector
                  workflow={workflow}
                  node={selectedNode}
                  hosts={hosts}
                  translate={translate}
                  onChange={(updater) => updateNode(selectedNode.id, updater)}
                  onDelete={() => deleteNodes([selectedNode.id])}
                  onDuplicate={() => duplicateNode(selectedNode)}
                  onClose={() => workflowEditorStore.selectNode(null)}
                />
              )}
            </div>

            <WorkflowRunDrawer
              workflow={workflow}
              run={displayedRun}
              history={runHistory}
              selectedRunId={selectedRunId}
              onSelectRun={setSelectedRunId}
              onClearHistory={() => workflowRunStore.clearHistory(workflow.id)}
              translate={translate}
            />
          </>
        )}
      </section>

      <Dialog.Root
        open={confirmRequest !== null}
        onOpenChange={(open) => {
          if (!open) resolveConfirm(false);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[440px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-background p-4 shadow-lg">
            <Dialog.Title className="text-sm font-medium">
              {translate('workflow.confirm.title', 'Confirm step')}: {confirmRequest?.title}
            </Dialog.Title>
            <Dialog.Description className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 font-mono text-[11px] text-muted-foreground">
              {confirmRequest?.message}
            </Dialog.Description>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-md border border-border/60 px-3 py-1 text-xs hover:bg-accent"
                onClick={() => resolveConfirm(false)}
              >
                {translate('workflow.confirm.decline', 'Decline')}
              </button>
              <button
                type="button"
                className="rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground hover:opacity-90"
                onClick={() => resolveConfirm(true)}
              >
                {translate('workflow.confirm.approve', 'Continue')}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
};

WorkflowView.displayName = 'WorkflowView';
