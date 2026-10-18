import { zhTWMonitorMessages } from './zh-TW/monitor';
import type { Messages } from './types';
import { zhTWCoreMessages } from './zh-TW/core';
import { zhTWVaultMessages } from './zh-TW/vault';
import { zhTWTerminalMessages } from './zh-TW/terminal';
import { zhTWAiMessages } from './zh-TW/ai';
import { zhTwSystemManagerMessages } from './zh-TW/systemManager';
import { zhTWScriptsMessages } from './zh-TW/scripts';
import { zhTWWorkflowMessages } from './zh-TW/workflow';

export type { Messages } from './types';

const zhTW: Messages = {
  ...zhTWMonitorMessages,
  ...zhTWCoreMessages,
  ...zhTWVaultMessages,
  ...zhTWTerminalMessages,
  ...zhTWAiMessages,
  ...zhTwSystemManagerMessages,
  ...zhTWScriptsMessages,
  ...zhTWWorkflowMessages,
};

export default zhTW;
