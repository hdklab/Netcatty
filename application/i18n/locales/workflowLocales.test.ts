import test from "node:test";
import assert from "node:assert/strict";

import { enWorkflowMessages } from "./en/workflow";
import { esWorkflowMessages } from "./es/workflow";
import { ruWorkflowMessages } from "./ru/workflow";
import { zhCNWorkflowMessages } from "./zh-CN/workflow";
import { zhTWWorkflowMessages } from "./zh-TW/workflow";

test("workflow loop controls are localized in every bundled language", () => {
  const messages = [
    enWorkflowMessages,
    esWorkflowMessages,
    ruWorkflowMessages,
    zhCNWorkflowMessages,
    zhTWWorkflowMessages,
  ];
  const keys = [
    "workflow.toolbar.loopLimit",
    "workflow.toolbar.loopLimitHint",
  ];

  for (const locale of messages) {
    for (const key of keys) {
      assert.equal(typeof locale[key], "string", `missing ${key}`);
      assert.notEqual(locale[key]?.trim(), "", `empty ${key}`);
    }
  }
});

test("every workflow locale exposes the same keys", () => {
  const locales = {
    es: esWorkflowMessages,
    ru: ruWorkflowMessages,
    "zh-CN": zhCNWorkflowMessages,
    "zh-TW": zhTWWorkflowMessages,
  } as const;
  const referenceKeys = Object.keys(enWorkflowMessages).sort();

  for (const [name, locale] of Object.entries(locales)) {
    assert.deepEqual(Object.keys(locale).sort(), referenceKeys, `${name} key set differs from en`);
  }
});
