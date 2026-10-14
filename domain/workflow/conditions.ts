/**
 * Condition evaluation for `condition` nodes. Pure: the runner interpolates the
 * two sides first, then asks this function which branch to take.
 */

import type { ConditionNodeConfig, ConditionOperator } from './types.ts';

export interface ConditionEvaluation {
  result: boolean;
  /** Human-readable explanation stored on the node run. */
  detail: string;
}

function quote(value: string): string {
  const trimmed = value.trim();
  const short = trimmed.length > 60 ? `${trimmed.slice(0, 57)}...` : trimmed;
  return JSON.stringify(short);
}

export function evaluateCondition(
  left: string,
  right: string,
  config: Pick<ConditionNodeConfig, 'operator' | 'caseSensitive'>,
): ConditionEvaluation {
  const operator: ConditionOperator = config.operator;
  const caseSensitive = config.caseSensitive === true;
  const normalizedLeft = caseSensitive ? left : left.toLowerCase();
  const normalizedRight = caseSensitive ? right : right.toLowerCase();

  switch (operator) {
    case 'equals':
      return {
        result: normalizedLeft === normalizedRight,
        detail: `${quote(left)} equals ${quote(right)}`,
      };
    case 'notEquals':
      return {
        result: normalizedLeft !== normalizedRight,
        detail: `${quote(left)} does not equal ${quote(right)}`,
      };
    case 'contains':
      return {
        result: normalizedRight.length > 0 && normalizedLeft.includes(normalizedRight),
        detail: `${quote(left)} contains ${quote(right)}`,
      };
    case 'notContains':
      return {
        result: normalizedRight.length === 0 || !normalizedLeft.includes(normalizedRight),
        detail: `${quote(left)} does not contain ${quote(right)}`,
      };
    case 'regex': {
      if (!right) return { result: false, detail: 'No pattern to match' };
      try {
        const matched = new RegExp(right, caseSensitive ? '' : 'i').test(left);
        return { result: matched, detail: `${quote(left)} matches /${right}/` };
      } catch (err) {
        return {
          result: false,
          detail: `Invalid regex /${right}/: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
    case 'truthy':
      return { result: left.trim().length > 0, detail: `${quote(left)} is not empty` };
    case 'falsy':
      return { result: left.trim().length === 0, detail: `${quote(left)} is empty` };
    default:
      return { result: false, detail: `Unsupported operator "${String(operator)}"` };
  }
}
