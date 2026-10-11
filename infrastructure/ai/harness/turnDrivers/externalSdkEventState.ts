import type { AgentActivity, AgentUsage } from '../../types';
import { estimateTextTokens } from '../tokenEstimator';

export function upsertAgentActivity(
  activities: AgentActivity[] | undefined,
  nextActivity: AgentActivity,
): AgentActivity[] {
  const current = activities ?? [];
  const existingIndex = current.findIndex((activity) => activity.id === nextActivity.id);
  if (existingIndex < 0) return [...current, nextActivity];
  return current.map((activity, index) => index === existingIndex ? nextActivity : activity);
}

/**
 * Usage fallback for CLI-backed agents that report no token counts at all.
 *
 * The output side matters as much as the input side: counting only the prompt
 * made every turn show "output 0" in the activity view even when the agent had
 * produced a long answer. Both sides go through the shared estimator, which is
 * CJK-aware (length/4 badly undercounts Chinese prompts).
 */
export function resolveEstimatedUsageFallback(
  prompt: string,
  actualUsageReported: boolean,
  outputText = '',
): AgentUsage | null {
  if (actualUsageReported) return null;
  const inputTokens = estimateTextTokens(prompt);
  const outputTokens = outputText ? estimateTextTokens(outputText) : 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimated: true,
  };
}
