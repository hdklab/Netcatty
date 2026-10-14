import React from 'react';
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from '@xyflow/react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface WorkflowEdgeProps extends EdgeProps {
  translate: (key: string, fallback: string) => string;
  onDelete: (edgeId: string) => void;
}

/**
 * Workflow connection: the routed path plus a delete affordance at the midpoint.
 * The button shows while the edge is selected (or hovered directly) so the
 * canvas stays quiet with many connections.
 */
export const WorkflowEdge: React.FC<WorkflowEdgeProps> = ({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  style,
  markerEnd,
  translate,
  onDelete,
}) => {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
      <EdgeLabelRenderer>
        <div
          className="absolute nodrag nopan"
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: 'all',
          }}
        >
          <button
            type="button"
            data-workflow-edge-delete={id}
            className={cn(
              'flex h-4 w-4 items-center justify-center rounded-full border border-border/60 bg-card text-muted-foreground shadow-sm transition-opacity',
              'hover:border-destructive/60 hover:text-destructive',
              selected ? 'opacity-100' : 'opacity-0 hover:opacity-100 focus-visible:opacity-100',
            )}
            onClick={(event) => {
              event.stopPropagation();
              onDelete(id);
            }}
            title={translate('workflow.edge.delete', 'Delete connection')}
          >
            <X size={10} />
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  );
};

WorkflowEdge.displayName = 'WorkflowEdge';
