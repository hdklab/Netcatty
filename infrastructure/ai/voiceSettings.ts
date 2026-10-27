/**
 * AI voice settings — the in-app agent's copy of the Hermes voice stack.
 *
 * The values deliberately mirror Hermes' `stt` / `tts` / `voice` blocks:
 * local faster-whisper for speech-to-text (`small`, Chinese), Edge TTS with a
 * Chinese voice for spoken replies, a short streaming minimum length so CJK
 * sentences are spoken as soon as one clause is complete, and an auto-speak
 * toggle equivalent to `voice.auto_tts`.
 */

import { localStorageAdapter } from '../persistence/localStorageAdapter';
import { STORAGE_KEY_AI_VOICE } from '../config/storageKeys';

export type AIVoiceSttModel = 'tiny' | 'base' | 'small' | 'medium' | 'large-v3';

export interface AIVoiceSttConfig {
  /** Python interpreter that carries faster-whisper + edge-tts. Empty = auto-detect. */
  pythonPath: string;
  model: AIVoiceSttModel;
  /** BCP-47-ish whisper language hint; empty means auto-detect. */
  language: string;
  /** faster-whisper device: cpu / cuda. */
  device: string;
  /** faster-whisper compute type: int8 / float16 / float32. */
  computeType: string;
}

export interface AIVoiceTtsConfig {
  voice: string;
  /** Edge TTS rate, e.g. "+0%". */
  rate: string;
  /** Shortest first segment spoken on its own — CJK needs a small value. */
  minLen: number;
}

export interface AIVoiceConfig {
  /** Show the composer microphone button. */
  inputEnabled: boolean;
  /** Speak assistant replies automatically (Hermes `voice.auto_tts`). */
  autoSpeak: boolean;
  stt: AIVoiceSttConfig;
  tts: AIVoiceTtsConfig;
}

export const VOICE_STT_MODEL_OPTIONS: Array<{ value: AIVoiceSttModel; label: string }> = [
  { value: 'tiny', label: 'tiny' },
  { value: 'base', label: 'base' },
  { value: 'small', label: 'small' },
  { value: 'medium', label: 'medium' },
  { value: 'large-v3', label: 'large-v3' },
];

/** Chinese Edge voices that are worth offering without a voice-list round-trip. */
export const VOICE_TTS_VOICE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 女声 (zh-CN)' },
  { value: 'zh-CN-XiaoyiNeural', label: '晓伊 · 女声 (zh-CN)' },
  { value: 'zh-CN-YunxiNeural', label: '云希 · 男声 (zh-CN)' },
  { value: 'zh-CN-YunjianNeural', label: '云健 · 男声 (zh-CN)' },
  { value: 'zh-CN-YunyangNeural', label: '云扬 · 男声 (zh-CN)' },
  { value: 'zh-TW-HsiaoChenNeural', label: '曉臻 · 女声 (zh-TW)' },
];

export const DEFAULT_AI_VOICE_CONFIG: AIVoiceConfig = {
  inputEnabled: true,
  // Hermes parity: `voice.auto_tts: true` — replies are spoken without a click.
  autoSpeak: true,
  stt: {
    pythonPath: '',
    model: 'small',
    language: 'zh',
    device: 'cpu',
    computeType: 'int8',
  },
  tts: {
    voice: 'zh-CN-XiaoxiaoNeural',
    rate: '+0%',
    minLen: 6,
  },
};

const MIN_MIN_LEN = 1;
const MAX_MIN_LEN = 60;

function normalizeMinLen(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_AI_VOICE_CONFIG.tts.minLen;
  return Math.min(MAX_MIN_LEN, Math.max(MIN_MIN_LEN, Math.round(parsed)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Tolerant read of a stored/loaded config; unknown or partial values fall back to defaults. */
export function sanitizeVoiceConfig(raw: unknown): AIVoiceConfig {
  const base = DEFAULT_AI_VOICE_CONFIG;
  if (!isRecord(raw)) return { ...base, stt: { ...base.stt }, tts: { ...base.tts } };
  const stt = isRecord(raw.stt) ? raw.stt : {};
  const tts = isRecord(raw.tts) ? raw.tts : {};
  const model = VOICE_STT_MODEL_OPTIONS.some((option) => option.value === stt.model)
    ? (stt.model as AIVoiceSttModel)
    : base.stt.model;
  return {
    inputEnabled: typeof raw.inputEnabled === 'boolean' ? raw.inputEnabled : base.inputEnabled,
    autoSpeak: typeof raw.autoSpeak === 'boolean' ? raw.autoSpeak : base.autoSpeak,
    stt: {
      pythonPath: typeof stt.pythonPath === 'string' ? stt.pythonPath : base.stt.pythonPath,
      model,
      language: typeof stt.language === 'string' ? stt.language : base.stt.language,
      device: typeof stt.device === 'string' && stt.device.trim() ? stt.device : base.stt.device,
      computeType: typeof stt.computeType === 'string' && stt.computeType.trim()
        ? stt.computeType
        : base.stt.computeType,
    },
    tts: {
      voice: typeof tts.voice === 'string' && tts.voice.trim() ? tts.voice.trim() : base.tts.voice,
      rate: typeof tts.rate === 'string' && tts.rate.trim() ? tts.rate.trim() : base.tts.rate,
      minLen: normalizeMinLen(tts.minLen),
    },
  };
}

const voiceConfigListeners = new Set<() => void>();

export function subscribeVoiceConfig(listener: () => void): () => void {
  voiceConfigListeners.add(listener);
  return () => {
    voiceConfigListeners.delete(listener);
  };
}

function notifyVoiceConfigChanged(): void {
  for (const listener of voiceConfigListeners) {
    try {
      listener();
    } catch (err) {
      console.error('[voiceSettings] listener failed:', err);
    }
  }
}

export function readVoiceConfig(): AIVoiceConfig {
  try {
    return sanitizeVoiceConfig(localStorageAdapter.read<unknown>(STORAGE_KEY_AI_VOICE));
  } catch {
    return sanitizeVoiceConfig(null);
  }
}

export function writeVoiceConfig(config: AIVoiceConfig): AIVoiceConfig {
  const next = sanitizeVoiceConfig(config);
  try {
    localStorageAdapter.write(STORAGE_KEY_AI_VOICE, next);
  } catch (err) {
    console.warn('[voiceSettings] could not persist voice settings:', err);
  }
  notifyVoiceConfigChanged();
  return next;
}

/** True when the config can actually reach a local engine (used to gate the mic button). */
export function isVoiceConfigured(config: AIVoiceConfig): boolean {
  return Boolean(config.stt.language || config.tts.voice);
}
