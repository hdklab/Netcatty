/**
 * useAIReadAloud — speak assistant replies with Edge TTS.
 *
 * Segmentation follows Hermes' `tts.streaming.min_len` idea: the answer is cut
 * into speakable segments, the first one is held back until it is long enough
 * for Chinese, and segments are synthesized and played in order so speech
 * starts before the whole answer has been rendered. Playback is cancellable
 * (barge-in): a new turn, a Stop click or unmount kills the pending synthesis
 * request and the audio element.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AIVoiceConfig } from '../../infrastructure/ai/voiceSettings';
import { buildSpeechSegments } from '../../infrastructure/ai/voiceSpeechText';
import { cancelVoiceRequest, synthesizeSpeech } from '../../infrastructure/services/voiceService';

export interface UseAIReadAloudOptions {
  voiceConfig: AIVoiceConfig;
  onError?: (message: string) => void;
}

export interface UseAIReadAloudReturn {
  speaking: boolean;
  /** Speak one markdown message; a no-op when the same message id was already spoken. */
  speak: (markdown: string, messageId?: string) => void;
  stop: () => void;
}

export function useAIReadAloud({ voiceConfig, onError }: UseAIReadAloudOptions): UseAIReadAloudReturn {
  const [speaking, setSpeaking] = useState(false);
  const configRef = useRef(voiceConfig);
  configRef.current = voiceConfig;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const cancelledRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const requestIdRef = useRef<string | null>(null);
  const spokenIdsRef = useRef<Set<string>>(new Set());
  const errorReportedRef = useRef(false);

  const teardownAudio = useCallback(() => {
    const audio = audioRef.current;
    audioRef.current = null;
    if (!audio) return;
    audio.onended = null;
    audio.onerror = null;
    try {
      audio.pause();
    } catch {
      // already stopped
    }
    audio.src = '';
  }, []);

  const stop = useCallback(() => {
    cancelledRef.current = true;
    const requestId = requestIdRef.current;
    requestIdRef.current = null;
    if (requestId) void cancelVoiceRequest(requestId);
    teardownAudio();
    setSpeaking(false);
  }, [teardownAudio]);

  const playAudio = useCallback((audioBase64: string, mimeType: string) => (
    new Promise<boolean>((resolve) => {
      const audio = new Audio(`data:${mimeType || 'audio/mpeg'};base64,${audioBase64}`);
      audioRef.current = audio;
      const settle = (played: boolean) => {
        audio.onended = null;
        audio.onerror = null;
        if (audioRef.current === audio) audioRef.current = null;
        resolve(played);
      };
      audio.onended = () => settle(true);
      audio.onerror = () => settle(false);
      void audio.play().then(() => undefined).catch(() => settle(false));
    })
  ), []);

  const speak = useCallback((markdown: string, messageId?: string) => {
    const config = configRef.current;
    if (messageId) {
      if (spokenIdsRef.current.has(messageId)) return;
      spokenIdsRef.current.add(messageId);
    }
    const segments = buildSpeechSegments(markdown, config.tts.minLen);
    if (!segments.length) return;

    stop();
    cancelledRef.current = false;
    errorReportedRef.current = false;
    setSpeaking(true);

    void (async () => {
      try {
        for (const segment of segments) {
          if (cancelledRef.current) return;
          const requestId = typeof crypto !== 'undefined' && crypto.randomUUID
            ? crypto.randomUUID()
            : `tts-${Date.now()}`;
          requestIdRef.current = requestId;
          const result = await synthesizeSpeech({
            text: segment,
            requestId,
            tts: config.tts,
            pythonPath: config.stt.pythonPath,
          });
          if (cancelledRef.current) return;
          if (!result.ok || !result.audioBase64) {
            if (!errorReportedRef.current) {
              errorReportedRef.current = true;
              onErrorRef.current?.(result.error || 'Speech synthesis failed.');
            }
            return;
          }
          requestIdRef.current = null;
          const played = await playAudio(result.audioBase64, result.mimeType || 'audio/mpeg');
          if (!played) return;
        }
      } finally {
        if (!cancelledRef.current) setSpeaking(false);
      }
    })();
  }, [playAudio, stop]);

  // Never leave audio playing after the panel goes away.
  useEffect(() => () => {
    cancelledRef.current = true;
    const requestId = requestIdRef.current;
    if (requestId) void cancelVoiceRequest(requestId);
    const audio = audioRef.current;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      try {
        audio.pause();
      } catch {
        // already stopped
      }
      audio.src = '';
    }
  }, []);

  return { speaking, speak, stop };
}
