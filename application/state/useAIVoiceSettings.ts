/**
 * useAIVoiceSettings — read/write the AI voice config and stay in sync with
 * other windows and other panels in this window.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  readVoiceConfig,
  sanitizeVoiceConfig,
  writeVoiceConfig,
  subscribeVoiceConfig,
  type AIVoiceConfig,
  type AIVoiceSttConfig,
  type AIVoiceTtsConfig,
} from '../../infrastructure/ai/voiceSettings';
import { STORAGE_KEY_AI_VOICE } from '../../infrastructure/config/storageKeys';

export interface AIVoiceConfigPatch {
  inputEnabled?: boolean;
  autoSpeak?: boolean;
  stt?: Partial<AIVoiceSttConfig>;
  tts?: Partial<AIVoiceTtsConfig>;
}

export function useAIVoiceSettings(): {
  voiceConfig: AIVoiceConfig;
  updateVoiceConfig: (patch: AIVoiceConfigPatch) => void;
  replaceVoiceConfig: (next: AIVoiceConfig) => void;
} {
  const [voiceConfig, setVoiceConfig] = useState<AIVoiceConfig>(readVoiceConfig);

  useEffect(() => {
    const sync = () => setVoiceConfig(readVoiceConfig());
    const unsubscribe = subscribeVoiceConfig(sync);
    const handleStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY_AI_VOICE) sync();
    };
    window.addEventListener('storage', handleStorage);
    sync();
    return () => {
      unsubscribe();
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  const replaceVoiceConfig = useCallback((next: AIVoiceConfig) => {
    setVoiceConfig(writeVoiceConfig(sanitizeVoiceConfig(next)));
  }, []);

  const updateVoiceConfig = useCallback((patch: AIVoiceConfigPatch) => {
    setVoiceConfig((previous) => {
      const next = sanitizeVoiceConfig({
        ...previous,
        ...patch,
        stt: patch.stt ? { ...previous.stt, ...patch.stt } : previous.stt,
        tts: patch.tts ? { ...previous.tts, ...patch.tts } : previous.tts,
      });
      return writeVoiceConfig(next);
    });
  }, []);

  return { voiceConfig, updateVoiceConfig, replaceVoiceConfig };
}
