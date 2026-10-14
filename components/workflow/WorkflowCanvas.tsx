import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeProps,
  type NodeProps,
  type OnConnect,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Maximize, Minus, Plus } from 'lucide-react';
import { useIsWorkflowsActive } from '@/application/state/activeTabStore';
import type { Host } from '@/domain/models';
import type {
  Workflow,
  WorkflowNodeKind,
  WorkflowOutputPort,
  WorkflowRun,
} from '@/domain/workflow/types.ts';
import type { WorkflowIssue } from '@/domain/workflow/validate.ts';
import { WorkflowNodeCard } from './WorkflowNodeCard.tsx';
import { WorkflowEdge } from './WorkflowEdge.tsx';
import { findFreeNodePosition } from '@/domain/workflow/layout.ts';
import {
  toFlowEdges,
  toFlowNodes,
  type WorkflowFlowNode,
} from './workflowFlowModel.ts';

export const WORKFLOW_NODE_DRAG_TYPE = 'application/netcatty-workflow-node';

export interface WorkflowCanvasProps {
  workflow: Workflow;
  hosts: Host[];
  run: WorkflowRun | null;
  issues: readonly WorkflowIssue[];
  translate: (key: string, fallback: string) => string;
  onSelectNode: (nodeId: string | null) => void;
  onMoveNode: (nodeId: string, position: { x: number; y: number }) => void;
  onConnectNodes: (params: {
    from: { nodeId: string; output: WorkflowOutputPort };
    to: { nodeId: string };
  }) => void;
  onDeleteEdge: (edgeId: string) => void;
  /** Drag an existing connection's endpoint onto another node. */
  onReconnectEdge?: (edgeId: string, params: {
    from: { nodeId: string; output: WorkflowOutputPort };
    to: { nodeId: string };
  }) => void;
  onDeleteNodes: (nodeIds: string[]) => void;
  onAddNode: (kind: WorkflowNodeKind, position: { x: number; y: number }) => void;
  /**
   * Hands the parent a "add node at the centre of the current viewport" helper,
   * so palette clicks land where the user is looking instead of at a fixed
   * canvas coordinate that may sit off-screen after panning/zooming.
   */
  registerAddNodeAtCenter?: (add: ((kind: WorkflowNodeKind) => void) | null) => void;
}

const WorkflowCanvasInner: React.FC<WorkflowCanvasProps> = ({
  workflow,
  hosts,
  run,
  issues,
  translate,
  onSelectNode,
  onMoveNode,
  onConnectNodes,
  onDeleteEdge,
  onDeleteNodes,
  onAddNode,
  registerAddNodeAtCenter,
  onReconnectEdge,
}) => {
  const flowNodes = useMemo(
    () => toFlowNodes({ workflow, hosts, run, issues, translate }),
    [workflow, hosts, run, issues, translate],
  );
  const flowEdges = useMemo(() => toFlowEdges(workflow, run), [workflow, run]);

  const [nodes, setNodes, onNodesChange] = useNodesState<WorkflowFlowNode>(flowNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(flowEdges);

  // The store is the source of truth; local state exists only so dragging stays
  // smooth between the drop and the commit.
  useEffect(() => {
    setNodes(flowNodes);
  }, [flowNodes, setNodes]);
  useEffect(() => {
    setEdges(flowEdges);
  }, [flowEdges, setEdges]);

  const { screenToFlowPosition, fitView, zoomIn, zoomOut } = useReactFlow();
  const isActive = useIsWorkflowsActive();
  const hasFitRef = useRef(false);
  const fittedForNodesRef = useRef(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // The surface is mounted hidden until its tab is opened, so the first real
  // layout only happens on activation — fit the graph then.
  useEffect(() => {
    if (!isActive || hasFitRef.current) return;
    const frame = requestAnimationFrame(() => {
      hasFitRef.current = true;
      void fitView({ padding: 0.3, maxZoom: 1 });
    });
    return () => cancelAnimationFrame(frame);
  }, [isActive, fitView]);

  // A workflow that starts empty has nothing to fit on activation; frame it once
  // the first node lands so new nodes are not dropped half off-screen.
  const nodeCount = workflow.nodes.length;
  useEffect(() => {
    if (fittedForNodesRef.current || !hasFitRef.current || nodeCount === 0) return;
    fittedForNodesRef.current = true;
    const frame = requestAnimationFrame(() => {
      void fitView({ padding: 0.25, maxZoom: 1 });
    });
    return () => cancelAnimationFrame(frame);
  }, [nodeCount, fitView]);

  const nodeTypes = useMemo(
    () => ({
      workflowNode: (props: NodeProps<WorkflowFlowNode>) => (
        <WorkflowNodeCard {...props} translate={translate} />
      ),
    }),
    [translate],
  );

  const edgeTypes = useMemo(
    () => ({
      workflow: (props: EdgeProps) => (
        <WorkflowEdge {...props} translate={translate} onDelete={onDeleteEdge} />
      ),
    }),
    [translate, onDeleteEdge],
  );

  const handleConnect: OnConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      if (connection.source === connection.target) return;
      onConnectNodes({
        from: {
          nodeId: connection.source,
          output: (connection.sourceHandle as WorkflowOutputPort | null) ?? 'main',
        },
        to: { nodeId: connection.target },
      });
    },
    [onConnectNodes],
  );

  const handleReconnect = useCallback(
    (oldEdge: Edge, connection: Connection) => {
      if (!onReconnectEdge) return;
      if (!connection.source || !connection.target) return;
      if (connection.source === connection.target) return;
      onReconnectEdge(oldEdge.id, {
        from: {
          nodeId: connection.source,
          output: (connection.sourceHandle as WorkflowOutputPort | null) ?? 'main',
        },
        to: { nodeId: connection.target },
      });
    },
    [onReconnectEdge],
  );

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const kind = event.dataTransfer.getData(WORKFLOW_NODE_DRAG_TYPE) as WorkflowNodeKind;
      if (!kind) return;
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      onAddNode(kind, { x: Math.round(position.x), y: Math.round(position.y) });
    },
    [onAddNode, screenToFlowPosition],
  );

  const handleDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const handleInit = useCallback((instance: ReactFlowInstance<WorkflowFlowNode>) => {
    instance.fitView({ padding: 0.3, maxZoom: 1 });
  }, []);

  useEffect(() => {
    if (!registerAddNodeAtCenter) return;
    registerAddNodeAtCenter((kind: WorkflowNodeKind) => {
      const rect = wrapperRef.current?.getBoundingClientRect();
      if (!rect) return;
      const center = screenToFlowPosition({
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
      });
      const position = findFreeNodePosition(
        { x: Math.round(center.x) - 110, y: Math.round(center.y) - 40 },
        workflow.nodes.map((node) => node.position),
      );
      onAddNode(kind, position);
    });
    return () => registerAddNodeAtCenter(null);
  }, [onAddNode, registerAddNodeAtCenter, screenToFlowPosition, workflow.nodes]);

  return (
    <div
      ref={wrapperRef}
      className="relative h-full w-full"
      data-workflow-canvas
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      <ReactFlow<WorkflowFlowNode, Edge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={handleConnect}
        onReconnect={handleReconnect}
        edgesReconnectable
        onInit={handleInit}
        onNodeClick={(_event, node) => onSelectNode(node.id)}
        onPaneClick={() => onSelectNode(null)}
        onNodeDragStop={(_event, node) => onMoveNode(node.id, { x: node.position.x, y: node.position.y })}
        onNodesDelete={(deleted) => onDeleteNodes(deleted.map((node) => node.id))}
        onEdgesDelete={(deleted) => deleted.forEach((edge) => onDeleteEdge(edge.id))}
        defaultEdgeOptions={{ type: 'smoothstep' }}
        fitView
        minZoom={0.3}
        maxZoom={2}
        deleteKeyCode={['Delete', 'Backspace']}
        snapToGrid
        snapGrid={[12, 12]}
        className="bg-background"
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
      </ReactFlow>

      {/* Own zoom controls: React Flow's built-in ones ship a light-only look
          that reads as white blocks on a dark theme. */}
      <div
        className="absolute right-3 top-3 z-10 flex flex-col overflow-hidden rounded-md border border-border/60 bg-card shadow-sm"
        data-workflow-canvas-controls
      >
        <button
          type="button"
          className="p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => void zoomIn()}
          title={translate('workflow.canvas.zoomIn', 'Zoom in')}
        >
          <Plus size={13} />
        </button>
        <button
          type="button"
          className="border-t border-border/60 p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => void zoomOut()}
          title={translate('workflow.canvas.zoomOut', 'Zoom out')}
        >
          <Minus size={13} />
        </button>
        <button
          type="button"
          className="border-t border-border/60 p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => void fitView({ padding: 0.25, maxZoom: 1 })}
          title={translate('workflow.canvas.fit', 'Fit to view')}
        >
          <Maximize size={13} />
        </button>
      </div>
    </div>
  );
};

export const WorkflowCanvas: React.FC<WorkflowCanvasProps> = (props) => (
  <ReactFlowProvider>
    <WorkflowCanvasInner {...props} />
  </ReactFlowProvider>
);

WorkflowCanvas.displayName = 'WorkflowCanvas';
