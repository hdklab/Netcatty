"use strict";

const { CAPABILITY_STATUS } = require("../constants.cjs");

/** Renderer-local harness tools; terminal reading also exposes a scoped MCP entry. */
/** @type {import("../types.cjs").CapabilityDefinition[]} */
const HARNESS_CAPABILITIES = [
  {
    id: "harness.tool_output.read",
    domain: "harness",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "Read stored tool output by handle id when a prior tool result was truncated.",
    policy: {
      write: false,
      sensitiveRead: false,
      longRunning: false,
      requiresChatSession: true,
      bypassesObserverBlock: false,
      bypassesApproval: true,
      bypassesChatCancel: true,
    },
    surfaces: {
      catty: { toolName: "tool_output_read" },
    },
  },
  {
    id: "harness.workspace.get_info",
    domain: "harness",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "Get information about the current workspace, including all terminal sessions and their connection status.",
    policy: {
      write: false,
      sensitiveRead: false,
      longRunning: false,
      requiresChatSession: true,
      bypassesObserverBlock: false,
      bypassesApproval: true,
      bypassesChatCancel: true,
    },
    surfaces: {
      catty: { toolName: "workspace_get_info" },
    },
  },
  {
    id: "harness.workspace.get_session_info",
    domain: "harness",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "Get detailed information about a specific terminal or SFTP session.",
    policy: {
      write: false,
      sensitiveRead: false,
      longRunning: false,
      requiresChatSession: true,
      bypassesObserverBlock: false,
      bypassesApproval: true,
      bypassesChatCancel: true,
    },
    surfaces: {
      catty: { toolName: "workspace_get_session_info" },
    },
  },
  {
    id: "harness.terminal.read_context",
    agentKinds: ["sidebar", "global"],
    domain: "harness",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "Read a bounded slice of the current terminal screen or scrollback from the active AI scope.",
    policy: {
      write: false,
      sensitiveRead: false,
      longRunning: false,
      requiresChatSession: true,
      bypassesObserverBlock: false,
      bypassesApproval: true,
      bypassesChatCancel: true,
    },
    surfaces: {
      catty: { toolName: "terminal_read_context" },
      builtin: { rpcMethod: "netcatty/readContext", mcpTool: "terminal_read_context" },
    },
  },
  {
    id: "harness.todo.manage",
    domain: "harness",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description:
      "Replace the chat's task list with the complete todo array. Use it to plan and track multi-step work so the user can see progress live. Use it when the request needs three or more distinct steps, when the user gives a numbered or comma-separated list of tasks, or when new instructions turn a small request into a multi-step job. Do not use it for a single trivial action, a purely conversational question, or a simple one-step lookup. Workflow: (1) write the full list first with short action-oriented titles (3-7 words); (2) mark exactly ONE item in-progress before starting that item; (3) do the work; (4) mark that item completed IMMEDIATELY after it succeeds; (5) move to the next item and repeat. Always send the complete array (all items), never a delta. Never batch completions: mark each item completed as soon as it is done, and do not mark an item completed if it failed or is blocked - keep it in-progress or not-started and say why. Status values: not-started (not begun), in-progress (currently working; at most one), completed (fully finished).",
    policy: {
      write: false,
      sensitiveRead: false,
      longRunning: false,
      requiresChatSession: true,
      bypassesObserverBlock: false,
      bypassesApproval: true,
      bypassesChatCancel: true,
    },
    surfaces: {
      catty: { toolName: "manage_todo_list" },
    },
  },
  {
    id: "harness.web.search",
    domain: "harness",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "Search the web for current information when configured in AI settings.",
    policy: {
      write: false,
      sensitiveRead: false,
      longRunning: false,
      requiresChatSession: true,
      bypassesObserverBlock: false,
      bypassesApproval: true,
      bypassesChatCancel: true,
    },
    surfaces: {
      catty: { toolName: "web_search" },
    },
  },
  {
    id: "harness.url.fetch",
    domain: "harness",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "Fetch and read the content of an HTTPS URL.",
    policy: {
      write: false,
      sensitiveRead: false,
      longRunning: false,
      requiresChatSession: true,
      bypassesObserverBlock: false,
      bypassesApproval: true,
      bypassesChatCancel: true,
    },
    surfaces: {
      catty: { toolName: "url_fetch" },
    },
  },
];

module.exports = { HARNESS_CAPABILITIES };
