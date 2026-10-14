import React from 'react';
import { GitBranch, Hand, Plus, Terminal, Timer } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { WorkflowNodeKind } from '@/domain/workflow/types.ts';
import { WORKFLOW_NODE_TYPES } from '@/domain/workflow/nodeCatalog.ts';
import { WORKFLOW_NODE_DRAG_TYPE } from './WorkflowCanvas.tsx';

const ICONS: Record<WorkflowNodeKind, React.ComponentType<{ size?: number; className?: string }>> = {
  hostCommand: Terminal,
  condition: GitBranch,
  delay: Timer,
  manual: Hand,
};

export interface WorkflowPaletteProps {
  translate: (key: string, fallback: string) => string;
  onAddNode: (kind: WorkflowNodeKind) => void;
}

export const WorkflowPalette: React.FC<WorkflowPaletteProps> = ({ translate, onAddNode }) => (
  <div className="flex w-[190px] shrink-0 flex-col gap-2 border-r border-border/60 p-3" data-workflow-palette>
    <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      {translate('workflow.palette.title', 'Nodes')}
    </div>
    <div className="flex flex-col gap-1.5">
      {WORKFLOW_NODE_TYPES.map((descriptor) => {
        const Icon = ICONS[descriptor.kind] ?? Terminal;
        return (
          <button
            key={descriptor.kind}
            type="button"
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData(WORKFLOW_NODE_DRAG_TYPE, descriptor.kind);
              event.dataTransfer.effectAllowed = 'move';
            }}
            onClick={() => onAddNode(descriptor.kind)}
            data-workflow-palette-item={descriptor.kind}
            className={cn(
              'group flex cursor-grab items-start gap-2 rounded-md border border-border/60 bg-card px-2.5 py-2 text-left',
              'hover:border-primary/60 hover:bg-accent/40 active:cursor-grabbing',
            )}
            title={translate(descriptor.descriptionKey, descriptor.kind)}
          >
            <Icon size={14} className="mt-0.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs">{translate(descriptor.labelKey, descriptor.kind)}</span>
              <span className="mt-0.5 block line-clamp-2 text-[10px] leading-tight text-muted-foreground">
                {translate(descriptor.descriptionKey, '')}
              </span>
            </span>
            <Plus size={12} className="mt-0.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
          </button>
        );
      })}
    </div>
    <div className="mt-1 text-[10px] leading-snug text-muted-foreground">
      {translate('workflow.palette.hint', 'Drag onto the canvas, or connect ports to chain steps.')}
    </div>
  </div>
);

WorkflowPalette.displayName = 'WorkflowPalette';
