/**
 * useAIVoiceInput — microphone capture for the AI composer.
 *
 * Records one clip with MediaRecorder, hands the bytes to the main process for
 * local faster-whisper transcription, and reports the transcript back so the
 * composer can append it. The mic stream is always released, including on
 * unmount, cancel and transcription failure.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AIVoiceSttConfig } from '../../infrastructure/ai/voiceSettings';
import {
  cancelVoiceRequest,
  onVoiceInstallProgress,
  transcribeVoiceClip,
} from '../../infrastructure/services/voiceService';

export type AIVoiceInputStatus = 'idle' | 'requesting' | 'recording' | 'transcribing' | 'installing';

export interface AIVoiceInputError {
  code: 'permission' | 'unsupported' | 'no-device' | 'empty' | 'transcribe';
  message: string;
}

export const VOICE_RECORDING_LIMIT_MS = 60_000;

function pickRecorderMimeType(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return '';
  }
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
}

function isCaptureSupported(): boolean {
  return typeof navigator !== 'undefined'
    && Boolean(navigator.mediaDevices?.getUserMedia)
    && typeof MediaRecorder !== 'undefined';
}

export interface UseAIVoiceInputOptions {
  stt: AIVoiceSttConfig;
  enabled: boolean;
  onTranscript: (transcript: string) => void;
}

export interface UseAIVoiceInputReturn {
  supported: boolean;
  status: AIVoiceInputStatus;
  error: AIVoiceInputError | null;
  clearError: () => void;
  start: () => Promise<void>;
  stop: () => void;
  cancel: () => void;
  toggle: () => void;
}

export function useAIVoiceInput({ stt, enabled, onTranscript }: UseAIVoiceInputOptions): UseAIVoiceInputReturn {
  const [status, setStatus] = useState<AIVoiceInputStatus>('idle');
  const [error, setError] = useState<AIVoiceInputError | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const limitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef<string | null>(null);
  const sttRef = useRef(stt);
  sttRef.current = stt;
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const statusRef = useRef<AIVoiceInputStatus>('idle');
  statusRef.current = status;

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (limitTimerRef.current) {
      clearTimeout(limitTimerRef.current);
      limitTimerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    recorderRef.current = null;
    chunksRef.current = [];
    requestIdRef.current = null;
    setStatus('idle');
  }, []);

  const cancel = useCallback(() => {
    const requestId = requestIdRef.current;
    if (requestId) {
      void cancelVoiceRequest(requestId);
      requestIdRef.current = null;
    }
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = null;
      try {
        recorder.stop();
      } catch {
        // already stopped
      }
    }
    releaseStream();
    reset();
  }, [releaseStream, reset]);

  const transcribe = useCallback(async (blob: Blob) => {
    setStatus('transcribing');
    const requestId = typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `voice-${Date.now()}`;
    requestIdRef.current = requestId;
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (!bytes.length) {
        setError({ code: 'empty', message: 'The recording was empty.' });
        reset();
        return;
      }
      const result = await transcribeVoiceClip({
        bytes,
        mimeType: blob.type || 'audio/webm',
        requestId,
        stt: sttRef.current,
      });
      if (requestIdRef.current !== requestId) return; // cancelled while transcribing
      if (!result.ok) {
        setError({ code: 'transcribe', message: result.error || 'Transcription failed.' });
        reset();
        return;
      }
      const transcript = (result.transcript || '').trim();
      if (!transcript) {
        setError({ code: 'empty', message: 'No speech was recognised.' });
        reset();
        return;
      }
      setError(null);
      reset();
      onTranscriptRef.current(transcript);
    } catch (err) {
      if (requestIdRef.current !== requestId) return;
      setError({ code: 'transcribe', message: String((err as Error)?.message || err) });
      reset();
    }
  }, [reset]);

  const start = useCallback(async () => {
    if (!enabled) return;
    if (!isCaptureSupported()) {
      setError({ code: 'unsupported', message: 'Recording is not available in this build.' });
      return;
    }
    if (statusRef.current === 'recording' || statusRef.current === 'requesting') return;
    setError(null);
    setStatus('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;
      const mimeType = pickRecorderMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        chunksRef.current = [];
        releaseStream();
        recorderRef.current = null;
        void transcribe(blob);
      };
      recorderRef.current = recorder;
      recorder.start();
      setStatus('recording');
      limitTimerRef.current = setTimeout(() => {
        const active = recorderRef.current;
        if (active && active.state !== 'inactive') {
          try {
            active.stop();
          } catch {
            // already stopped
          }
        }
      }, VOICE_RECORDING_LIMIT_MS);
    } catch (err) {
      releaseStream();
      reset();
      const name = String((err as Error)?.name || '');
      const denied = name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError';
      const missing = name === 'NotFoundError' || name === 'DevicesNotFoundError';
      setError({
        code: denied ? 'permission' : missing ? 'no-device' : 'unsupported',
        message: String((err as Error)?.message || err),
      });
    }
  }, [enabled, releaseStream, reset, transcribe]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;
    try {
      recorder.stop();
    } catch {
      releaseStream();
      reset();
    }
  }, [releaseStream, reset]);

  const toggle = useCallback(() => {
    if (statusRef.current === 'recording') stop();
    else if (statusRef.current === 'idle') void start();
    else if (statusRef.current === 'transcribing' || statusRef.current === 'installing') cancel();
  }, [cancel, start, stop]);

  // The first clip on a machine without a voice engine installs one inside the
  // same transcribe call; progress events turn the spinner into a named status.
  useEffect(() => {
    const unsubscribe = onVoiceInstallProgress(() => {
      if (statusRef.current === 'transcribing') setStatus('installing');
    });
    return unsubscribe;
  }, []);

  const clearError = useCallback(() => setError(null), []);

  useEffect(() => () => {
    const requestId = requestIdRef.current;
    if (requestId) void cancelVoiceRequest(requestId);
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = null;
      try {
        recorder.stop();
      } catch {
        // already stopped
      }
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (limitTimerRef.current) clearTimeout(limitTimerRef.current);
  }, []);

  return {
    supported: isCaptureSupported(),
    status,
    error,
    clearError,
    start,
    stop,
    cancel,
    toggle,
  };
}
