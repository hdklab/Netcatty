# Aligning Netcatty's agent module with VS Code's agent design

Status: implemented in this milestone (M1). Source of comparison: the VS Code
checkout at `~/workspace/vscode` (1.143.0, `4d0303f3946`). Netcatty paths are
relative to the repo root.

## Why VS Code is the reference

VS Code's chat surface is the most mature open implementation of an "agentic"
assistant: a session list, selectable agent roles, a model-maintained todo list,
isolated subagents, per-tool confirmation and a plan-review handoff. Netcatty's
Catty already has the hard parts (tool catalog, permission modes, approval,
compaction, trace store, MCP, external SDK agents) but exposes none of the
*planning and delegation* affordances. The goal is parity of **surface and
semantics**, not a port: VS Code is a code editor with a workspace file tree;
Netcatty drives live terminals, SFTP and a vault, so its "tools" and its
"checkpoint" story are different.

## What VS Code has (verified in the checkout)

| Concern | VS Code | Path |
|---|---|---|
| Agent roles | Ask / Agent / Plan (+ Research preview); role switch mid-session | `src/vs/workbench/contrib/chat/common/chatModes.ts`, `common/participants/*`, `browser/chat*` |
| Plan review | Plan agent ends with a plan; a review tool renders it and hands off to Agent | `common/tools/builtinTools/reviewPlanTool.ts` |
| Todo list | `manage_todo_list` tool + service + UI; one `in-progress` item max | `common/tools/builtinTools/manageTodoListTool.ts`, `browser/chatTodoListService.ts` |
| Subagents | `runSubagent`: own context, stateless, returns one report, max nesting 5, custom-agent/model selection | `common/tools/builtinTools/runSubagentTool.ts`, `browser/widget/chatContentParts/chatSubagentContentPart.ts` |
| Todo/subagent tool data | model-facing descriptions carry the workflow rules | same files |
| Tool confirmation | risk assessment + confirmation service + per-session approvals | `browser/tools/chatToolRiskAssessmentService.ts`, `browser/tools/languageModelToolsConfirmationService.ts` |
| Checkpoints | edit session with per-request checkpoints and undo | `common/editing/chatEditingService.ts`, `browser/chatEditing/*` |
| Sessions | agent-sessions view, filters, local/cloud harnesses | `browser/agentSessions/*`, `common/chatSessionsService.ts` |
| Custom agents | `.github/agents/*.agent.md`, `.claude/agents/*.md`, tools/model/agents allowlists | `common/promptSyntax/*` |
| Instruction files | `AGENTS.md`, `.instructions.md`, prompt files | `common/promptSyntax/computeAutomaticInstructions.ts` |
| Tool result compression | compressor service keeps long results out of the prompt | `browser/tools/toolResultCompressor.ts` |
| Debug/trace | flow graph + debug events | `browser/chatDebug/*` |

## What Netcatty has today

| Concern | Netcatty | Path |
|---|---|---|
| Chat surface | global AI sidebar, per-scope sessions, history drawer | `components/AIChatSidePanel.tsx`, `components/ai/*`, `application/state/ai*` |
| Agents | Catty (in-app `streamText`) + external SDK agents (Hermes/Codex/dsh), model per agent | `infrastructure/ai/harness/turnDrivers/*`, `components/ai/AgentSelector.tsx` |
| Tools | 74 catalog entries, renderer-local harness tools, MCP export | `electron/capabilities/catalog/*`, `infrastructure/ai/harness/capabilityTools.ts` |
| Permissions | observer / confirm / auto + per-tool approval + session grants | `infrastructure/ai/harness/cattyToolApproval.ts`, `permissionGrants.ts` |
| Context | compaction (pre-turn, 413, step), tool-output handles, dedup | `contextManager.ts`, `toolOutputStore.ts`, `toolResultDedup.ts` |
| Trace | session event log with usage/performance/compaction | `traceStore.ts`, `agentEventAdapter.ts` |
| Planning | **only a system-prompt sentence** ("plan before acting") | `infrastructure/ai/cattyAgent/systemPrompt.ts` |
| Delegation | **none** | — |
| Roles | **none** (permission mode only) | — |

## Gap and scope of this milestone

Delivered here (three independent slices, built in parallel):

1. **Agent roles: Ask / Agent / Plan.** A role picker in the composer, stored per
   user, mapped onto the existing permission modes without weakening them:
   - `ask` → read-only: observer-equivalent tool filtering, no action tools.
   - `agent` → today's behaviour, permission mode decides the rest.
   - `plan` → read-only research plus a mandatory closing plan; the chat shows a
     "Start execution" action that switches the role to `agent` and sends the
     continuation turn.
   The role is injected into the system prompt as a short section so the model
   knows what it may do; it never replaces the permission mode's own gating.
2. **Todo list (`manage_todo_list`).** A Catty-local harness tool that takes the
   complete array of items (`id`, `title`, `status`), validates (max one
   `in-progress`, 1..50 items, unique ids) and publishes it to a per-chat-session
   store. The chat renders a compact panel above the composer: progress, current
   item, collapsible list. State is per chat session and survives tab switches;
   it is cleared when the session is deleted. The model-facing tool description
   carries VS Code's workflow rules (mark in-progress before work, complete
   immediately, never batch completions).
3. **Subagent (`run_subagent`).** A tool that runs a nested Catty turn with an
   isolated message history and a read-only tool subset, then returns a single
   report string to the parent. Depth is limited to 1 (a subagent cannot spawn
   subagents), the parent's abort signal cancels it, and prompts/results are
   capped. The tool call renders as a collapsible card (running/done/failed,
   read-only badge, elapsed time) instead of a generic tool row.

## Non-goals (deliberately not copied)

- **Checkpoints/undo of remote edits.** VS Code checkpoints local files. Netcatty
  writes over SFTP and runs shell commands; a faithful undo needs remote
  snapshots + a rollback UX. Tracked separately.
- **`*.agent.md` custom agent files.** Netcatty's agent list is a registry of
  external SDK CLIs plus Catty; a file format with tools/model allowlists is a
  larger design (where do the files live? which tools are addressable?). Not in
  this milestone.
- **Agents window / cloud handoff / worktrees.** No cloud executor, no git
  worktree; out of scope.
- **Nested subagents (depth > 1).** VS Code allows 5; we cap at 1 until the trace
  store and UI can represent a tree.

## Contracts

- `manage_todo_list({ todoList: [{ id: number, title: string, status:
  'not-started' | 'in-progress' | 'completed' }] })` → `{ ok, todoList, error? }`.
  The tool belongs to the Catty surface only (`surfaces.catty`), is
  non-destructive (`write: false`), bypasses approval, and is unavailable in
  `ask`/`plan` roles only in the sense that it stays allowed — planning is the
  point of those roles.
- `run_subagent({ prompt, description, allowWrites?: false })` → `{ report,
  model?, steps, elapsedMs, error? }`. Read-only always in M1; `allowWrites` is
  rejected with a clear error rather than silently ignored.
- Role state: `netcatty_ai_agent_role_v1` (`ask` | `agent` | `plan`), default
  `agent`. Per user, not per chat: switching a role is a stance, not a setting
  of the conversation.

## Acceptance

- Tool round-trip: the model can call `manage_todo_list` and the panel reflects
  the list without a reload; two chat sessions keep independent lists.
- Roles: `ask`/`plan` never execute `terminal_execute` / SFTP writes / vault
  writes (observer gating); `plan` shows the execution action; switching to
  `agent` and pressing it sends the continuation with the plan as context.
- Subagent: `run_subagent` returns a report; cancellation aborts the nested
  turn; depth 1 enforced; the card shows running → done.
- `npm run lint` 0 errors; scoped suites green; generated capability artifacts
  regenerated (`npm run generate:capability-tools`) and unchanged on re-run.

## Implementation status (M1)

Landed and green:

- Todo: `harness.todo.manage` catalog entry (`electron/capabilities/catalog/harness.cjs`),
  regenerated `cattyToolSpecs.json` (75 sidebar specs), executor case + nested zod
  schema in `capabilityTools.ts`, `agentTodo.ts` (validation), `agentTodoStore.ts`
  (per-session, LRU 100), `components/ai/AgentTodoPanel.tsx`, mounted through
  `AIChatPanelContent.tsx`'s `todoPanel` slot; cleared on chat deletion.
- Roles: `application/state/agentRole.ts` (+ tests), storage key
  `netcatty_ai_agent_role_v1`, `resolveEffectivePermissionMode` applied in
  `cattyRuntimeContext.ts` (ask/plan → observer for that turn only), role section in
  `cattyAgent/systemPrompt.ts`, `components/ai/AgentRolePicker.tsx` in the composer,
  plan→execute handoff in `ChatInput.tsx`.
- Subagent: `subagentRunner.ts` (read-only allowlist, depth 1, abort + 90 s cap,
  20k report cap), `run_subagent` injected in `cattyStreamProcessor.ts` for the
  sidebar agent only, `SubagentCallCard.tsx` dispatched from `ChatMessageList.tsx`.

Verification: `npm run lint` 0 errors; 190 tests across the touched suites;
`npm run pack:dir` succeeds and the bundle contains `manage_todo_list`,
`run_subagent`, `netcatty_ai_agent_role_v1` and the new i18n keys.

Known limits:

- All three surfaces are Catty-only. External SDK agents (Hermes / Codex / dsh)
  run their own loops and cannot be given Netcatty tools or roles.
- A profile with no configured Catty provider hides the role picker and cannot
  exercise any of it end-to-end.
- The plan→execute continuation message is a hard-coded ASCII sentence; it needs a
  locale key if it should follow the UI language.
- `run_subagent` cards render through `ChatMessageList.tsx`, not `ToolCallGroup.tsx`
  (that component only wraps groups of 2+ calls).

## Update: the planning surfaces are agent-agnostic

Catty was removed from the shipped agent list (commit b12001165), so the three
M1 surfaces initially only existed for an agent the product no longer offers.
Todo + subagent are now **observational** as well as injectable:

- `infrastructure/ai/harness/externalAgentSignals.ts` recognises the external
  CLIs' own planning calls — `todo_write` / `TodoWrite` / `update_plan` (todo
  payloads: `{todos|plan|todoList: [{content|step|title, status}]}`) and
  `run_subagent` / `delegate_task` / `Task` / `agent` (delegation).
- `ChatMessageList` mirrors the latest todo payload into the same per-session
  store the panel reads, so the task list appears for Hermes / dsh / Codex /
  Claude sessions too; the subagent card renders their delegation calls.
- Roles (Ask/Agent/Plan) remain Catty-only: external CLIs own their own modes.

Verified in the packaged app against a real external-agent session: a
`todo_write` call renders “任务清单 已完成 1/3 …”, and a `delegate_task` call
renders the subagent card with status/elapsed/report.
