import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AgentRolePicker, AGENT_ROLE_OPTIONS } from './AgentRolePicker';
import { TooltipProvider } from '../ui/tooltip';

test('lists the three roles in ask/agent/plan order with label and description keys', () => {
  assert.deepEqual(
    AGENT_ROLE_OPTIONS.map((option) => option.role),
    ['ask', 'agent', 'plan'],
  );
  assert.deepEqual(
    AGENT_ROLE_OPTIONS.map((option) => option.labelKey),
    ['ai.role.ask', 'ai.role.agent', 'ai.role.plan'],
  );
  assert.deepEqual(
    AGENT_ROLE_OPTIONS.map((option) => option.descriptionKey),
    ['ai.role.ask.description', 'ai.role.agent.description', 'ai.role.plan.description'],
  );
});

test('the trigger shows the current role and is labelled for assistive tech', () => {
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <AgentRolePicker
        role="plan"
        onSelect={() => {}}
        open={false}
        onOpenChange={() => {}}
      />
    </TooltipProvider>,
  );

  assert.match(html, /aria-label="ai\.role\.label"/);
  assert.match(html, />ai\.role\.plan</);
  assert.match(html, /aria-expanded="false"/);
  // A closed popover must not leak the role menu into the composer.
  assert.doesNotMatch(html, /ai\.role\.ask\.description/);
});

test('a disabled picker cannot open and is marked disabled', () => {
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <AgentRolePicker
        role="agent"
        onSelect={() => {}}
        disabled
        open={false}
        onOpenChange={() => {}}
      />
    </TooltipProvider>,
  );

  assert.match(html, /<button[^>]*disabled=""/);
  assert.match(html, />ai\.role\.agent</);
});
