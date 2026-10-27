import type { AIVoiceSttConfig, AIVoiceTtsConfig } from '../../infrastructure/ai/voiceSettings';

declare global {
  interface NetcattyBridge {
    // Voice: local speech-to-text (faster-whisper) and text-to-speech (edge-tts)
    voiceProbe?(options?: { pythonPath?: string }): Promise<VoiceProbeResult>;
    voiceTranscribe?(request: {
      requestId?: string;
      audioBase64: string;
      mimeType?: string;
      pythonPath?: string;
      model?: AIVoiceSttConfig['model'];
      language?: string;
      device?: string;
      computeType?: string;
    }): Promise<{
      ok: boolean;
      transcript?: string;
      language?: string | null;
      duration?: number | null;
      error?: string;
    }>;
    voiceSynthesize?(request: {
      requestId?: string;
      text: string;
      voice?: AIVoiceTtsConfig['voice'];
      rate?: string;
      pythonPath?: string;
    }): Promise<{
      ok: boolean;
      audio?: string;
      mimeType?: string;
      error?: string;
    }>;
    voiceCancel?(requestId: string): Promise<boolean>;
  }

  interface VoiceProbeCandidate {
    python: string;
    ok: boolean;
    stt: string | null;
    tts: string | null;
    error?: string;
  }

  interface VoiceProbeResult {
    ok: boolean;
    python: string | null;
    stt: string | null;
    tts: string | null;
    error?: string;
    candidates?: VoiceProbeCandidate[];
  }
}
