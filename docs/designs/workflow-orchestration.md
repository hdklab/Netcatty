# Workflow Orchestration (n8n-style node graph for multi-host runs)

Status: **engine core implemented, canvas not started.**
See *Implementation status* at the end for what exists today.

## Goal

Today a Netcatty automation script is one script x N sessions, with a
sequential/parallel switch:

- `TerminalLayer.tsx:2250` — `handleRunScriptOnWorkspace(snippet, mode)`
- `electron/bridges/scriptBridge.cjs:602` — `netcatty:script:run` fans out to
  `sessionIds`, `mode: "sequential" | "parallel"`

What is missing is *ordering between different hosts and different operations*:
host A does step 1, host B does step 2 only after A succeeded, host C does step 3
only if a check on B matched, and everything downstream of a failure stops.

The goal is a visual, node-graph orchestrator for that: drag nodes onto a canvas,
wire dependencies, run, watch per-node status.

## Non-goals (v1)

- Replacing automation scripts. A `script` node type *calls* an existing
  `kind: "script"` snippet; the editor and `nct` runtime stay as they are.
- n8n's item-stream data model (`items[]` of `json`/`binary`), its expression
  engine, its credential system, its 400+ integration nodes, its queue mode.
- Multi-user / server-side scheduling. Netcatty is a desktop client.
- Data pipelining between nodes beyond simple value interpolation.

## Why not copy n8n literally

| n8n construct | Keep? | Netcatty shape |
|---|---|---|
| Declarative node types (`inputs`/`outputs`/`properties`) | yes | `domain/workflow/nodeCatalog.ts`, one descriptor per kind |
| `connections[source][outputIndex][]` | semantics only | flat `edges[]` with `{from:{nodeId,output}}`, uuid-keyed |
| `main` output array index means branch | yes | named ports: `main`, `true`, `false`, `error` |
| per-node `runData[nodeName][runIndex][itemIndex]` | yes, simplified | `WorkflowRun.nodeRuns[nodeId].hosts[hostRecord]` |
| Execution order = canvas position, one branch at a time (n8n 1.0+) | **no** | dependency-ready nodes run in parallel (hosts are independent); per-host serialization only |
| `continueOnError` / `retryOnFail` / `onError=continueErrorOutput` | yes | `node.onError`, `node.retry`, dedicated `error` port |
| Error Workflow + Error Trigger | later | failure banner + node-level error port in v1 |
| Item-based expressions `{{ $json.x }}` | no | small whitelisted interpolator, see below |
| Pin data / replay from failed node | yes | last `NodeRunResult` retained, "rerun from here" |
| Merge / IF / Switch / Wait / Loop / SplitInBatches | partly | `condition`, `delay`, `manual` in v1; merge = implicit `all-of` join |
| Trigger nodes (manual / cron / webhook) | partly | manual in v1; existing onConnect/onOutput triggers as node inputs in M4 |

The important divergence: n8n is a data pipeline where every node must receive
items to run; Netcatty's nodes are *actions on machines*. So the runtime is a
DAG scheduler, not an item pump, and parallelism is the default rather than a
canvas-order walk.

## Existing primitives to build on

| Capability | Where | Use in workflows |
|---|---|---|
| SSH exec, exit code + stdout/stderr, own connection | `electron/bridges/sshBridge/execCommand.cjs`, `boundedSshExec.cjs`, bridge method `execCommand` (`types/global/netcatty-bridge-session.d.ts:205`) | default `hostCommand` runner; no PTY, no open tab needed |
| Exec on an already-open session, per-session serial queue | `electron/bridges/systemManager/execOnSession.cjs` | "visible in the terminal" mode |
| `nct` script on a PTY session | `netcatty:script:run`, `electron/scripts/scriptRuntime.cjs` | `script` node type (needs an open session) |
| Host -> connection payload incl. jump chain | `application/state/sftp/useSftpHostCredentials.ts:38` (`buildSftpHostCredentials`) | node target resolution; do not write a second credential path |
| SFTP / transfer | `transferBridge`, `serverStats` | `transfer` node type (M3) |
| Port forwarding rules | `infrastructure/services/portForwardingService.ts` | `portForward` node type (M3) |
| Command blocklist | `domain/commandBlocklist.ts` + `lib/commandBlocklist.json` | pre-flight block on `hostCommand` |
| Permission modes | `netcatty_ai_permission_mode` (`scriptAutomationCoordinator.ts:15`) | observer/confirm/auto gate for whole runs |
| External-store + snapshot pattern | `application/state/scriptRunsStore.ts` | run state store |
| Retention of run records | `electron/scripts/scriptRunRetention.cjs` | run history pruning |
| Target selection (hosts / group paths / all) | `Snippet.targets` / `targetGroups` / `targetsAllHosts`, `SelectHostPanel` | node target picker |

## Domain model

New directory `domain/workflow/` (pure, no I/O; unit-tested with `node --test`).

```ts
export type WorkflowNodeKind =
  | 'hostCommand'   // M1: run shell command(s) over SSH on 1..N hosts
  | 'condition'     // M2: evaluate expression/regex, two outputs
  | 'delay'         // M1: wait N ms / until timestamp
  | 'manual'        // M2: pause until the user confirms
  | 'script'        // M3: run an existing kind:"script" snippet on open sessions
  | 'transfer'      // M3: SFTP upload/download
  | 'portForward'   // M3: start a saved rule
  | 'notify';       // M4: desktop notification

export interface WorkflowNode {
  id: string;                    // uuid; stable across renames, used by expressions
  kind: WorkflowNodeKind;
  name: string;                  // unique per workflow, shown on the canvas
  position: { x: number; y: number };
  config: HostCommandConfig | ConditionConfig | DelayConfig | /* … */;
  onError?: 'stop' | 'continue' | 'errorPort';  // default 'stop'
  retry?: { maxAttempts: number; delayMs: number };
  timeoutMs?: number;                           // per attempt
  disabled?: boolean;                           // kept on canvas, skipped at runtime
}

export interface WorkflowEdge {
  id: string;
  from: { nodeId: string; output: 'main' | 'true' | 'false' | 'error' };
  to: { nodeId: string; input: 'main' };
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  settings: {
    concurrency: number;             // max hosts executed in parallel, default 4
    onError: 'stop' | 'continue';    // workflow-level default
    variables?: Record<string, string>;
  };
  createdAt: number;
  updatedAt: number;
  revision: number;                  // bumped on every edit; stamped into runs
  schema: 1;
}

export interface HostCommandConfig {
  targets: { mode: 'hosts' | 'groups' | 'all'; hostIds?: string[]; groupPaths?: string[] };
  command: string;                   // may contain {{ }} interpolations
  expectedExitCodes?: number[];      // default [0]
  successPattern?: string;           // regex on stdout; overrides exit-code check
  failurePattern?: string;           // regex on stdout; fails the host even on exit 0
  failFast?: boolean;                // stop this node's remaining hosts on first failure
  concurrency?: number;              // overrides settings.concurrency for this node
  requiresConfirm?: boolean;         // always prompt before this node runs
}
```

Run state lives outside the workflow (never persisted into the definition):

```ts
export type NodeRunStatus =
  | 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'waiting';

export interface HostRunResult {
  hostId: string; hostLabel: string;
  ok: boolean;
  exitCode?: number;
  stdout?: string; stderr?: string;      // truncated, see Retention
  durationMs: number;
  attempts: number;
  error?: string;
}

export interface NodeRunResult {
  nodeId: string;
  status: NodeRunStatus;
  startedAt?: number; endedAt?: number;
  hosts: HostRunResult[];
  outputPort?: 'main' | 'true' | 'false' | 'error';
  error?: string;
  skippedReason?: string;
}

export interface WorkflowRun {
  runId: string;
  workflowId: string;
  workflowRevision: number;              // run history stays readable after edits
  status: 'running' | 'success' | 'failed' | 'cancelled';
  startedAt: number; endedAt?: number;
  nodeRuns: Record<string, NodeRunResult>;
  log: { at: number; nodeId?: string; level: 'info' | 'warn' | 'error'; message: string }[];
}
```

## Validation (`domain/workflow/validate.ts`)

Reported up front, blocking the run button, not at execution time:

- loop detection (DFS back edges): a cycle is legal and reads as "on failure,
  restart from the step the edge points back to", bounded by
  `settings.maxLoopIterations` (default 3; a value below 1 is an error);
  unreachable nodes, dangling edges (missing node ids);
- duplicate node names; empty `condition` with two outputs vs. one;
- `condition` missing a `false` or `true` edge (warn, not error);
- target resolution: unknown host ids, group paths that resolve to nothing today;
- missing required config (command text, delay ms);
- disabled node that still has downstream edges (warn: downstream still receives
  its input as skipped);
- self-referencing host in a jump chain is *not* this layer's problem
  (`domain/vaultJumpGraph.ts` already validates it).

## Execution engine (`domain/workflow/runPlan.ts` + `application/state/workflowRunner.ts`)

Pure/impure split so the scheduler is testable without SSH:

1. `buildRunPlan(workflow, startNodeIds?) -> { levels, readyOrder, joinPolicy }`
   A topological layering (Kahn). Same-host nodes are additionally ordered:
   two nodes touching the same host must not run concurrently.
2. `application/state/workflowRunner.ts` drives it with an injected executor
   interface:

```ts
export interface NodeExecutor {
  runHostCommand(node, host, ctx): Promise<HostRunResult>;
  // later: runScript, transfer, portForward, notify
}
export interface RunContext {
  runId: string;
  variables: Record<string, string>;
  signal: AbortSignal;
  previous?: Record<string, NodeRunResult>;   // for "rerun from here"
  onUpdate(result: NodeRunResult): void;
  onLog(entry: WorkflowRun['log'][number]): void;
}
```

Semantics:

- A node is *ready* when every upstream edge is settled **and** the upstream node
  routed its output to this edge's port. A node whose inputs all settled on a
  non-matching port is `skipped` (reason: `condition-false`), not failed.
- Join policy is `all-of` for v1: if any upstream failed and it is not an
  `errorPort` edge, the downstream node is `skipped` (`upstream-failed`).
- `onError: 'errorPort'` routes to downstream of the `error` port and does not
  block `main` siblings; `'continue'` marks the node failed but keeps `main`
  alive (n8n's `continueRegularOutput`).
- Fan-out within a node = one `HostRunResult` per target host, concurrency
  bounded by `node.concurrency ?? settings.concurrency`. `failFast` aborts the
  node's remaining hosts (they become `skipped`).
- Retry is per host per attempt (`node.retry`), then `onError` applies.
- Timeout per attempt (`node.timeoutMs`, default 60s), maps onto
  `execCommand({ timeout })`.
- Cancellation: one `AbortController` for the run; every in-flight host exec is
  aborted, settled results are kept and the run ends `cancelled`. There must be
  exactly one stop path for the whole run (`stopWorkflowRun()`), mirroring the
  `stopAgentTurn()`/`stopScriptRun()` convention — no per-node ad-hoc aborts.
- "Rerun from here": reuse `previous` results for nodes already `success` on the
  same revision (n8n pin data without the UI), re-run the rest.

## Interpolation (`domain/workflow/expression.ts`)

Deliberately not an expression engine — no `eval`, no user JS.

```
{{ nodes.<nodeId>.stdout }}              // first/only host's stdout
{{ nodes.<nodeId>.hosts.<hostId>.stdout }}
{{ nodes.<nodeId>.exitCode }}
{{ nodes.<nodeId>.ok }}
{{ workflow.vars.<name> }}
{{ run.id }} {{ run.startedAt }}
```

Optional trailing filters (whitelist, implemented in-repo):
`| trim`, `| head(<n>)`, `| tail(<n>)`, `| match(/<regex>/)`, `| default("<v>")`.
Unknown tokens are a validation error. Values are resolved at node start from
settled upstream results only (no forward references).

## Node type: `hostCommand`

The M1 workhorse. `targets` reuses the snippet target shape, so groups stay
dynamic against the current host inventory — resolve them through
`domain/snippetTargets.ts:53` `getRunnableHostsForSnippet(targets, hosts)`
instead of writing a second resolver.

Execution path per host (default, "silent"):

```
renderer (workflowRunner)
  -> buildSftpHostCredentials(host, vault, keychain)      // one code path for creds
  -> netcattyBridge.execCommand({ ...creds, command, timeout })
  -> HostRunResult { exitCode, stdout, stderr }
```

Optimization to consider in M2 (not M1): when a host already has an open
terminal session, route through the systemManager exec queue
(`execOnSession.cjs`) instead of opening a second SSH connection, and optionally
echo the command/output into that terminal so the run is watchable.

## Persistence

- Definitions: `STORAGE_KEY_WORKFLOWS = 'netcatty_workflows_v1'` in
  `infrastructure/config/storageKeys.ts`, read/written through
  `localStorageAdapter` (no bare `localStorage`, per lint rules).
- Run history: separate key, pruned to the last N runs per workflow with
  per-node stdout truncated (64 KB/node default), following
  `scriptRunRetention.cjs`. History is device-local.
- Import/export: own JSON (like snippet packages) so a workflow can be shared
  without a vault export.
- Cloud sync: **out of scope for v1** — adding a `workflows` entity to
  `domain/syncMerge.ts` means a new tombstones/migration story; do it after the
  schema is stable.

## UI

### Entry point

A new Vault sub-page next to Hosts / Keychain / Port Forwarding / Snippets /
Known Hosts (`VaultView.tsx` section union, `AsidePanel` design system for the
list + detail panels). Opening a workflow switches the main pane to the editor.

### Editor (n8n-shaped)

- **Left rail**: node palette, grouped by category, with search; click to add at
  viewport center or drag onto the canvas.
- **Canvas**: pan (space/middle-drag), zoom (wheel, ctrl+wheel), box select,
  node drag, connect by dragging an output handle to an input handle, delete edge
  (select + `Delete`, or hover ✕), copy/paste, undo/redo (`Ctrl+Z` / `Ctrl+Shift+Z`),
  snap-to-grid, fit-to-view.
- **Node card**: kind icon, name, target summary (`3 hosts` / group path),
  status badge while running, output handles only for the ports the kind defines
  (`condition` = `true`/`false`, everything = `main` + optional `error`).
- **Right panel**: parameters of the selected node (targets via
  `SelectHostPanel`, command in the Monaco snippet editor, error policy, retry,
  timeout, disable). Same `AsidePanel` look as the rest of the Vault.
- **Top bar**: Save, Run, Run-from-selected-node, run mode (parallel/sequential),
  concurrency, permission hint (observer blocks writes), validation badge.
- **Bottom drawer**: run timeline (per node: status, host count, duration),
  log stream, per-host stdout/stderr accordions, Stop, "Rerun from here",
  history of previous runs.

### Status colours

`pending` neutral, `running` accent + spinner, `success` green, `failed` red,
`skipped` dashed neutral, `waiting` (manual/delay) amber. Edges highlight while
their upstream is running.

### Canvas dependency

Preferred: `@xyflow/react` (React Flow 12, MIT, peer `react >= 17`, no native
deps; registry reachable from this machine — checked). It covers pan/zoom/
handles/bounds but not the palette, validation or node chrome, which we build.

Fallback if a new runtime dependency is unacceptable: a hand-rolled canvas
(SVG edges + absolutely positioned node cards + `transform: scale()` viewport).
Cheaper to audit, roughly 2-3x the UI work for select/zoom/connect.

## Security and permissions

- Runs honor the existing permission mode: `observer` refuses nodes that write or
  connect; `confirm` shows one pre-run summary dialog (hosts x commands x
  destructive-command hits) with per-node approval for `requiresConfirm` nodes.
- Every `hostCommand` is checked against `domain/commandBlocklist.ts` before it
  is sent; a blocked command fails validation with the matching pattern.
- Credentials are resolved at run time from vault/keychain; nothing
  credential-shaped is ever written into a workflow definition, run history or
  export.
- Optional per-node output redaction in history (M4).

## Testing

- `domain/workflow/*.test.ts` — graph validation (cycle, dangling edge, duplicate
  name, orphan node), layering and same-host ordering, join policy, condition
  routing, retry/timeout policy, interpolation (including unknown-token
  rejection), plan output for a fixed fixture graph.
- Runner tests with a fake `NodeExecutor` that records call order and timestamps:
  assert dependency order, parallelism ceiling, per-host serialization, failFast,
  cancel semantics, rerun-from-here with pinned results.
- Store/hook tests in the `scriptRunsStore` style (snapshot subscription,
  no re-render storms).
- UI: source-text assertions per the repo convention
  (`readFileSync(new URL('./X.tsx', import.meta.url))` + `assert.match`).
- i18n: a `workflow.*` namespace added to all five locales; the
  `*Locales.test.ts` parity suites enforce it.

## Milestones

Decisions taken: cloud sync is **not planned** (definitions stay device-local),
and the first shippable slice starts at the canvas — there is no list-based
editor interim. The engine below is therefore a prerequisite of the canvas
slice, not a separate milestone: a canvas with no runnable engine is a mockup.

**E1 — engine core (no UI).** `domain/workflow/` model, validation, run plan,
interpolation, `hostCommand` executor over `execCommand`, run store, run
history. Acceptance: a fixture graph (A -> B -> C serial, D parallel after A)
executes against fake executors in tests, and against real SSH hosts through a
temporary harness entry point.

**E2 — canvas editor.** `@xyflow/react` canvas: node palette (drag/click to add),
connect by handle drag, pan/zoom/box-select, delete edge, undo/redo, node
parameter panel, live per-node status, run drawer with per-host stdout, Stop.
Acceptance: build a 3-node graph on the canvas with real hosts, run it, watch
nodes turn green/red, a failing node stops the chain.

**E3 — branching and richer nodes.** `condition` node with `true`/`false` ports,
`manual` confirmation node, `delay`, error port + retry UI, rerun-from-here with
retained results, session-reuse execution mode.
Acceptance: a graph where host B runs only when host A's stdout matches a regex.

**E4 — automation surface.** `script`/`transfer`/`portForward` node kinds,
triggers (schedule / onConnect / onOutput), import/export, expose workflows to
Catty and the CLI (`capabilities/catalog`), completion notifications.

## Open decisions

1. **Canvas**: resolved — add `@xyflow/react` (React Flow 12, MIT, no native
   deps).
2. **Engine location**: renderer for E1-E3 (every executor already sits behind a
   renderer bridge). Consequence to accept: a window reload interrupts a run.
   Moving to the main process is what unattended/background runs would need; the
   executor interface is isolated so that stays possible.
3. **Silent vs visible execution** default: separate SSH connection per host
   (silent) in E1/E2, "reuse the open terminal session" as an E3 mode.
4. **Hosts behind a jump chain**: `netcatty:ssh:exec` (`execCommand.cjs`) opens a
   direct connection only — `connectThroughChain` is the session path. So a
   `hostCommand` node currently supports direct SSH hosts; a host whose
   `hostChain.hostIds` is non-empty must fail validation with a clear message
   rather than silently connecting to the wrong machine. Reusing an open session
   (which does support the chain) is the E3 fix.
5. **Cloud sync**: resolved — out of scope.

## Implementation status

Landed (all covered by `node --test --import tsx` suites, 53 tests green):

| File | Role |
|---|---|
| `domain/workflow/types.ts` | workflow/node/edge/run types, defaults |
| `domain/workflow/validate.ts` | graph shape + target checks, command blocklist hit, node/host resolution |
| `domain/workflow/runPlan.ts` | topological order, cycle members, `computeReadyNodes`, busy-host collection, run summary |
| `domain/workflow/expression.ts` | `{{ }}` interpolation, whitelisted paths, filters (trim/upper/lower/head/tail/match/default) |
| `domain/workflow/conditions.ts` | condition operators |
| `domain/workflow/commandOutcome.ts` | exit-code vs success/failure-pattern verdict per host |
| `domain/workflow/concurrency.ts` | bounded parallel map with fail-fast/abort |
| `domain/workflow/loops.ts` | DFS back-edge detection, restart targets, downstream reset set |
| `domain/workflow/nodeCatalog.ts` | node kind descriptors, ports, default configs, unique names |
| `application/state/workflowRunner.ts` | scheduler loop + injected `WorkflowExecutor` |

Semantics worth remembering when building the canvas on top:

- Per-host work inside a node runs with `config.concurrency ?? settings.concurrency`
  (default 4); two *nodes* never touch the same host at the same time, and the
  runner starts one node per scheduling round to keep that invariant.
- `failFast` can only stop hosts that have not started yet, so it needs
  `concurrency: 1` (or a short throughput) to mean anything for a fan-out node.
- A finished node without an explicit verdict is a success. Missing this made
  every downstream node wait forever — the runner now normalizes it.
- Referencing a node that does not exist (`{{ nodes.typo.stdout }}`) fails the
  node; adding `| default("…")` declares the reference may be missing and
  substitutes the fallback instead.
- `disabled` nodes settle as `skipped`, which cascades `upstream-skipped` to
  their downstream — a disabled node does not act as a pass-through.
- A skipped node's downstream skips too (reason `condition-false`,
  `upstream-failed`, `upstream-skipped`, `cancelled`, `manual-declined`).
- Failed nodes activate their output port from the error policy: `stop` →
  nothing, `continue` → `main`, `errorPort` → `error`.

Not started: persistence (`netcatty_workflows_v1`), the real `execCommand`
executor with vault credentials, and the canvas UI. `@xyflow/react` 12.12.0 is
installed.

### Update: canvas slice landed

| File | Role |
|---|---|
| `domain/workflow/serialize.ts` | tolerant load/normalize for stored or imported definitions |
| `application/state/workflowStore.ts` | definitions collection (`netcatty_workflows_v1`), revision bump per edit |
| `application/state/workflowEditorStore.ts` | open workflow, selection, undo/redo stacks |
| `application/state/workflowRunStore.ts` | active run + pruned local history (`netcatty_workflow_runs_v1`) |
| `application/state/workflowSshExecutor.ts` | real executor: `buildSftpHostCredentials` → `netcatty:ssh:exec` |
| `application/state/useWorkflowRunner.ts` | validate → run → run-store bridging hook |
| `components/workflow/WorkflowView.tsx` | tab surface: list, toolbar, palette, canvas, inspector, run drawer |
| `components/workflow/WorkflowCanvas.tsx` | React Flow canvas (drag/connect/select/delete, drop from palette) |
| `components/workflow/workflowFlowModel.ts` | domain graph ↔ React Flow nodes/edges, status colours |
| `components/workflow/WorkflowNodeCard.tsx` | node card with per-port handles and status chrome |
| `components/workflow/WorkflowPalette.tsx` / `WorkflowInspector.tsx` / `WorkflowRunDrawer.tsx` | palette, node settings, run timeline + per-host output |

Wiring: a new root tab `workflows` (`TopTabs` + `activeTabStore` +
`AppMounts.WorkflowViewMount`, lazily mounted and kept alive while hidden), two
new storage keys, and a `workflow.*` message namespace in all five locales.

Still open from E2/E3: the "rerun from failed node" button (the runner already
accepts `previousResults`), import/export, and scheduled triggers.

### Loops (bounded retry)

A user draws "when this fails, go back to the start" by wiring a node's output
back to an earlier node. `findBackEdges` (DFS) marks the edge that closes the
cycle; scheduling ignores marked edges, so the graph the scheduler walks stays a
DAG and the loop head is a normal start node again.

At runtime, a failing node that owns an outgoing back edge resets that edge's
target **and everything downstream of it** (the failing node included) back to
`pending`; the scheduler then runs those nodes again. `settings.maxLoopIterations`
(default 3) bounds the attempts — when the budget is spent the failure stands and
the node's regular `onError` policy applies. `{{ loop.iteration }}` exposes the
1-based attempt number so a command or condition can react to the retry.

The attempt budget is per run, not per node: one counter for the whole graph.
Each restart clears the previous attempt's per-host output for the resetted
nodes (the run log keeps the "restarting from …" entry).

### Execution channels

| Channel | Hosts | How | Limits |
|---|---|---|---|
| `exec` | direct SSH | `netcatty:ssh:exec` with vault credentials | needs a direct connection; returns an exit code |
| `session` | telnet / serial / mosh / et / local, and SSH behind a jump chain | the command is typed into that host's open terminal and the output is parsed from the screen snapshot | the session must be open and idle; no exit code; only the visible screen; the run is visible in that terminal |

- `domain/workflow/channel.ts#resolveExecutionChannel` picks the channel per host;
  the executor is `application/state/workflowExecutor.ts`, the session half is
  `application/state/workflowSessionExecutor.ts`.
- Output extraction is pure and tested (`domain/workflow/sessionOutput.ts`): the
  next prompt line ends the response, ANSI noise is stripped, and the echo of the
  command anchors the start. A missing echo means the session refused the input
  (busy with a full-screen program) and the host run fails with that reason.
- Session channels have no exit code, so `evaluateCommandOutcome` treats a
  missing code as success unless `successPattern` / `failurePattern` are set —
  those are the way to judge a telnet or serial device.
- Validation downgraded `unsupported-protocol` and `jump-chain-unsupported` from
  errors to warnings ("will run inside the host's open terminal").

### Canvas interactions

- Condition outputs carry `Y` / `N` badges (the error port shows `!`), so the
  branch a connection takes is readable without hovering.
- Connections render through a custom edge (`components/workflow/WorkflowEdge.tsx`)
  with a delete button at the midpoint, visible while the edge is selected or
  hovered; `Delete`/`Backspace` still removes a selected edge or node.
- An existing connection's endpoint can be dragged onto another node
  (`onReconnect` → `reconnectEdge`, which drops the duplicate the move creates).

Verified in the packaged app over CDP (`./scripts/run-ui.sh dist --data-dir
~/.local/share/netcatty-preview-profile --debug`): the Workflows root tab renders
its surface, palette clicks place nodes in free slots around the viewport centre
(`domain/workflow/layout.ts`), a real handle drag creates an edge, a two-node
graph (Wait -> Wait) runs to `success` with the dependency order visible in the
run log, and a graph with unresolved references blocks the Run button with a
banner. Two details that only show up in the real app: React Flow's built-in
`<Controls>` renders as white blocks on a dark theme (replaced by our own zoom
buttons), and a graph created empty is not framed by the activation-time
`fitView`, so the canvas re-fits when the first node lands.

