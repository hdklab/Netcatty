import type { Messages } from './types';
import { zhCNCoreMessages } from './zh-CN/core';
import { zhCNVaultMessages } from './zh-CN/vault';
import { zhCNTerminalMessages } from './zh-CN/terminal';
import { zhCNAiMessages } from './zh-CN/ai';
import { zhCnSystemManagerMessages } from './zh-CN/systemManager';
import { zhCNScriptsMessages } from './zh-CN/scripts';
import { zhCNWorkflowMessages } from './zh-CN/workflow';

export type { Messages } from './types';

const zhCN: Messages = {
  ...zhCNCoreMessages,
  ...zhCNVaultMessages,
  ...zhCNTerminalMessages,
  ...zhCNAiMessages,
  ...zhCnSystemManagerMessages,
  ...zhCNScriptsMessages,
  ...zhCNWorkflowMessages,
};

export default zhCN;
