/**
 * Voice service — the renderer's only door to the main-process voice bridge.
 *
 * STT runs locally through faster-whisper, TTS through Edge TTS; both live in
 * one user-configured Python environment (see `infrastructure/ai/voiceSettings`).
 */

import { netcattyBridge } from './netcattyBridge';
import type { AIVoiceSttConfig, AIVoiceTtsConfig } from '../ai/voiceSettings';

export interface VoiceProbeCandidate {
  python: string;
  ok: boolean;
  stt: string | null;
  tts: string | null;
  error?: string;
}

export interface VoiceProbeReport {
  ok: boolean;
  python: string | null;
  stt: string | null;
  tts: string | null;
  error?: string;
  candidates?: VoiceProbeCandidate[];
}

const UNAVAILABLE: VoiceProbeReport = {
  ok: false,
  python: null,
  stt: null,
  tts: null,
  error: 'Voice bridge unavailable',
};

export async function probeVoiceEngine(pythonPath?: string): Promise<VoiceProbeReport> {
  const bridge = netcattyBridge.get();
  if (!bridge?.voiceProbe) return UNAVAILABLE;
  try {
    return await bridge.voiceProbe({ pythonPath: pythonPath || undefined });
  } catch (err) {
    return { ...UNAVAILABLE, error: String((err as Error)?.message || err) };
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export async function transcribeVoiceClip(params: {
  bytes: Uint8Array;
  mimeType: string;
  requestId?: string;
  stt: AIVoiceSttConfig;
}): Promise<{ ok: boolean; transcript?: string; error?: string }> {
  const bridge = netcattyBridge.get();
  if (!bridge?.voiceTranscribe) return { ok: false, error: 'Voice bridge unavailable' };
  try {
    const result = await bridge.voiceTranscribe({
      requestId: params.requestId,
      audioBase64: bytesToBase64(params.bytes),
      mimeType: params.mimeType,
      pythonPath: params.stt.pythonPath || undefined,
      model: params.stt.model,
      language: params.stt.language,
      device: params.stt.device,
      computeType: params.stt.computeType,
    });
    return {
      ok: Boolean(result?.ok),
      transcript: result?.transcript ?? '',
      error: result?.error,
    };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message || err) };
  }
}

export async function synthesizeSpeech(params: {
  text: string;
  requestId?: string;
  tts: AIVoiceTtsConfig;
  pythonPath?: string;
}): Promise<{ ok: boolean; audioBase64?: string; mimeType?: string; error?: string }> {
  const bridge = netcattyBridge.get();
  if (!bridge?.voiceSynthesize) return { ok: false, error: 'Voice bridge unavailable' };
  try {
    const result = await bridge.voiceSynthesize({
      requestId: params.requestId,
      text: params.text,
      voice: params.tts.voice,
      rate: params.tts.rate,
      pythonPath: params.pythonPath || undefined,
    });
    return {
      ok: Boolean(result?.ok),
      audioBase64: result?.audio,
      mimeType: result?.mimeType,
      error: result?.error,
    };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message || err) };
  }
}

export async function cancelVoiceRequest(requestId: string): Promise<boolean> {
  const bridge = netcattyBridge.get();
  if (!bridge?.voiceCancel) return false;
  try {
    return await bridge.voiceCancel(requestId);
  } catch {
    return false;
  }
}
