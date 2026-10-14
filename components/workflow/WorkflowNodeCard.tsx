import React from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import {
  AlertTriangle,
  CircleSlash,
  GitBranch,
  Hand,
  Loader2,
  Terminal,
  Timer,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { WorkflowOutputPort } from '@/domain/workflow/types.ts';
import { statusClassName, type WorkflowFlowNode } from './workflowFlowModel.ts';

const ICONS: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  hostCommand: Terminal,
  condition: GitBranch,
  delay: Timer,
  manual: Hand,
};

const PORT_LABEL_KEYS: Record<WorkflowOutputPort, string> = {
  main: 'workflow.port.main',
  true: 'workflow.port.true',
  false: 'workflow.port.false',
  error: 'workflow.port.error',
};

/** Short badge drawn next to an output handle; `main` needs none. */
const PORT_BADGES: Partial<Record<WorkflowOutputPort, string>> = {
  true: 'Y',
  false: 'N',
  error: '!',
};

export interface WorkflowNodeCardProps extends NodeProps<WorkflowFlowNode> {
  /** i18n helper passed by the canvas (node cards render outside the context). */
  translate: (key: string, fallback: string) => string;
}

export const WorkflowNodeCard: React.FC<WorkflowNodeCardProps> = ({ data, selected, translate }) => {
  const { node, status, summary, outputs, errorCount, warningCount } = data;
  const Icon = ICONS[node.kind] ?? Terminal;
  const isRunning = status === 'running' || status === 'waiting';

  return (
    <div
      className={cn(
        'relative w-[220px] rounded-lg border bg-card text-card-foreground shadow-sm transition-colors',
        statusClassName(status),
        selected && 'ring-2 ring-primary/60',
        node.disabled && 'opacity-60',
      )}
      data-workflow-node={node.id}
      data-workflow-node-status={status}
    >
      <Handle
        type="target"
        position={Position.Left}
        id="main"
        className="!z-10 !h-2.5 !w-2.5 !bg-border"
      />

      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <Icon size={14} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{node.name}</span>
        {isRunning && <Loader2 size={12} className="animate-spin text-primary" />}
        {node.disabled && <CircleSlash size={12} className="text-muted-foreground" />}
        {(errorCount > 0 || warningCount > 0) && errorCount === 0 && (
          <AlertTriangle size={12} className="text-amber-500" />
        )}
        {errorCount > 0 && <AlertTriangle size={12} className="text-destructive" />}
      </div>

      <div className="px-3 py-2 pb-3 text-[11px] leading-snug text-muted-foreground">
        <div className="line-clamp-2 break-words">{summary}</div>
      </div>

      {outputs.map((port, index) => (
        <React.Fragment key={port}>
          <Handle
            type="source"
            id={port}
            position={Position.Right}
            className={cn('!z-10 !h-2.5 !w-2.5', port === 'error' ? '!bg-destructive' : '!bg-primary')}
            style={{ top: `${((index + 1) / (outputs.length + 1)) * 100}%` }}
            title={translate(PORT_LABEL_KEYS[port], port)}
          />
          {PORT_BADGES[port] && (
            <span
              className={cn(
                'pointer-events-none absolute right-3 -translate-y-1/2 text-[9px] font-semibold',
                port === 'error' ? 'text-destructive' : 'text-muted-foreground',
              )}
              style={{ top: `${((index + 1) / (outputs.length + 1)) * 100}%` }}
              data-workflow-port-badge={port}
              aria-hidden
            >
              {PORT_BADGES[port]}
            </span>
          )}
        </React.Fragment>
      ))}
    </div>
  );
};

WorkflowNodeCard.displayName = 'WorkflowNodeCard';
