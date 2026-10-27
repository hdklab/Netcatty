import React, { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Download, Loader2, XCircle } from "lucide-react";
import { useI18n } from "../../../../application/i18n/I18nProvider";
import { useAIVoiceSettings } from "../../../../application/state/useAIVoiceSettings";
import {
  VOICE_STT_MODEL_OPTIONS,
  VOICE_TTS_VOICE_OPTIONS,
  type AIVoiceSttModel,
} from "../../../../infrastructure/ai/voiceSettings";
import {
  installVoiceEngine,
  onVoiceInstallProgress,
  probeVoiceEngine,
  type VoiceProbeReport,
} from "../../../../infrastructure/services/voiceService";
import { Select, SettingCard, SettingRow, SettingsSection, Toggle } from "../../settings-ui";

const INPUT_CLASS =
  "w-64 h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

type ProbeState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "done"; report: VoiceProbeReport };

type InstallState =
  | { status: "idle" }
  | { status: "installing"; message?: string }
  | { status: "done" }
  | { status: "failed"; error?: string };

/**
 * Settings → AI → Voice: the in-app agent's speech input and spoken replies.
 * The knobs mirror the Hermes voice stack (local faster-whisper STT, Edge TTS
 * with a Chinese voice, `min_len` for the first spoken segment, auto read-aloud).
 */
export const VoiceSettings: React.FC = () => {
  const { t } = useI18n();
  const { voiceConfig, updateVoiceConfig } = useAIVoiceSettings();
  const [probe, setProbe] = useState<ProbeState>({ status: "idle" });
  const [install, setInstall] = useState<InstallState>({ status: "idle" });
  const probeSeqRef = useRef(0);

  const runProbe = useCallback(async (pythonPath: string) => {
    const seq = ++probeSeqRef.current;
    setProbe({ status: "checking" });
    const report = await probeVoiceEngine(pythonPath);
    if (probeSeqRef.current !== seq) return;
    setProbe({ status: "done", report });
  }, []);

  /** One-click engine install for machines that have no Python with faster-whisper. */
  const runInstall = useCallback(async () => {
    setInstall({ status: "installing" });
    const result = await installVoiceEngine();
    if (!result.ok) {
      setInstall({ status: "failed", error: result.error });
      return;
    }
    setInstall({ status: "done" });
    // Pin the managed interpreter so later clips skip discovery entirely.
    if (result.python) updateVoiceConfig({ stt: { pythonPath: result.python } });
    void runProbe(result.python || "");
  }, [runProbe, updateVoiceConfig]);

  useEffect(() => onVoiceInstallProgress((progress) => {
    setInstall((current) => (
      current.status === "installing" ? { status: "installing", message: progress.message } : current
    ));
  }), []);

  useEffect(() => {
    void runProbe(voiceConfig.stt.pythonPath);
    // Probe once per mount, and again only when the interpreter is edited by the button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const languageValue = voiceConfig.stt.language;

  return (
    <SettingsSection title={t("ai.voice.title")} anchorId="ai-voice-enable">
      <SettingCard divided>
        <SettingRow
          label={t("ai.voice.inputEnabled")}
          description={t("ai.voice.inputEnabled.description")}
        >
          <Toggle
            checked={voiceConfig.inputEnabled}
            onChange={(inputEnabled) => updateVoiceConfig({ inputEnabled })}
            ariaLabel={t("ai.voice.inputEnabled")}
          />
        </SettingRow>

        <SettingRow
          anchorId="ai-voice-auto-speak"
          label={t("ai.voice.autoSpeak")}
          description={t("ai.voice.autoSpeak.description")}
        >
          <Toggle
            checked={voiceConfig.autoSpeak}
            onChange={(autoSpeak) => updateVoiceConfig({ autoSpeak })}
            ariaLabel={t("ai.voice.autoSpeak")}
          />
        </SettingRow>

        <SettingRow
          anchorId="ai-voice-model"
          label={t("ai.voice.model")}
          description={t("ai.voice.model.description")}
        >
          <Select
            value={voiceConfig.stt.model}
            options={VOICE_STT_MODEL_OPTIONS}
            onChange={(model) => updateVoiceConfig({ stt: { model: model as AIVoiceSttModel } })}
            className="w-40"
          />
        </SettingRow>

        <SettingRow
          anchorId="ai-voice-language"
          label={t("ai.voice.language")}
          description={t("ai.voice.language.description")}
        >
          <input
            type="text"
            value={languageValue}
            placeholder="zh"
            onChange={(event) => updateVoiceConfig({ stt: { language: event.target.value } })}
            className="w-24 h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </SettingRow>

        <SettingRow
          anchorId="ai-voice-voice"
          label={t("ai.voice.voice")}
          description={t("ai.voice.voice.description")}
        >
          <Select
            value={voiceConfig.tts.voice}
            options={VOICE_TTS_VOICE_OPTIONS}
            onChange={(voice) => updateVoiceConfig({ tts: { voice } })}
            className="w-56"
          />
        </SettingRow>

        <SettingRow
          anchorId="ai-voice-rate"
          label={t("ai.voice.rate")}
          description={t("ai.voice.rate.description")}
        >
          <input
            type="text"
            value={voiceConfig.tts.rate}
            placeholder="+0%"
            onChange={(event) => updateVoiceConfig({ tts: { rate: event.target.value } })}
            className="w-24 h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </SettingRow>

        <SettingRow
          anchorId="ai-voice-min-len"
          label={t("ai.voice.minLen")}
          description={t("ai.voice.minLen.description")}
        >
          <input
            type="number"
            min={1}
            max={60}
            value={voiceConfig.tts.minLen}
            onChange={(event) => {
              const parsed = Number(event.target.value);
              if (!Number.isFinite(parsed)) return;
              updateVoiceConfig({ tts: { minLen: Math.min(60, Math.max(1, Math.round(parsed))) } });
            }}
            className="w-20 h-9 rounded-md border border-input bg-background px-3 text-sm text-right focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </SettingRow>

        <SettingRow
          anchorId="ai-voice-python"
          align="start"
          label={t("ai.voice.python")}
          description={t("ai.voice.python.description")}
        >
          <div className="flex flex-col items-end gap-2">
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={voiceConfig.stt.pythonPath}
                placeholder={t("ai.voice.python.placeholder")}
                onChange={(event) => updateVoiceConfig({ stt: { pythonPath: event.target.value } })}
                className={INPUT_CLASS}
              />
              <button
                type="button"
                onClick={() => void runProbe(voiceConfig.stt.pythonPath)}
                disabled={probe.status === "checking"}
                className="h-9 shrink-0 rounded-md border border-border/60 px-3 text-sm text-foreground/85 transition-colors hover:bg-muted/40 disabled:opacity-60"
              >
                {probe.status === "checking" ? t("ai.voice.checking") : t("ai.voice.check")}
              </button>
              {probe.status === "done" && !probe.report.ok && (
                <button
                  type="button"
                  onClick={() => void runInstall()}
                  disabled={install.status === "installing"}
                  data-voice-install={install.status}
                  className="flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 text-sm text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
                >
                  {install.status === "installing" ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Download size={12} />
                  )}
                  {install.status === "installing" ? t("ai.voice.installing") : t("ai.voice.install")}
                </button>
              )}
            </div>
            <div
              data-voice-probe-status={probe.status === "done" ? (probe.report.ok ? "ok" : "missing") : probe.status}
              className="flex max-w-[360px] items-start gap-1.5 text-xs text-muted-foreground"
            >
              {probe.status === "checking" && <Loader2 size={12} className="mt-0.5 shrink-0 animate-spin" />}
              {probe.status === "done" && probe.report.ok && (
                <CheckCircle2 size={12} className="mt-0.5 shrink-0 text-emerald-500" />
              )}
              {probe.status === "done" && !probe.report.ok && (
                <XCircle size={12} className="mt-0.5 shrink-0 text-destructive" />
              )}
              <span className="min-w-0 break-words">
                {probe.status === "done"
                  ? probe.report.ok
                    ? t("ai.voice.status.ok", {
                      stt: probe.report.stt || "-",
                      tts: probe.report.tts || "-",
                    })
                    : `${t("ai.voice.status.missing")}${probe.report.error ? ` — ${probe.report.error}` : ""}`
                  : t("ai.voice.python.hint")}
              </span>
            </div>
            {install.status === "installing" && (
              <div className="max-w-[360px] truncate text-xs text-muted-foreground" data-voice-install-progress>
                {install.message || t("ai.voice.installing")}
              </div>
            )}
            {install.status === "failed" && (
              <div className="max-w-[360px] break-words text-xs text-destructive">
                {t("ai.voice.install.failed")} {install.error}
              </div>
            )}
          </div>
        </SettingRow>
      </SettingCard>
    </SettingsSection>
  );
};
