#!/usr/bin/env python3
"""Transcribe one local audio file with faster-whisper.

Usage:
    stt_worker.py <audio_path> <model> <language> <device> <compute_type>

Prints exactly one JSON line on stdout:
    {"ok": true, "transcript": "...", "language": "zh", "duration": 4.2}
    {"ok": false, "error": "..."}
Progress and library warnings must never reach stdout — the bridge parses the
last stdout line as JSON, so anything chatty would break it.
"""

import json
import sys


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main(argv):
    if len(argv) < 6:
        emit({"ok": False, "error": "usage: stt_worker.py <audio> <model> <language> <device> <compute_type>"})
        return 2

    audio_path, model_name, language, device, compute_type = argv[1:6]
    model_name = model_name.strip() or "small"
    device = device.strip() or "cpu"
    compute_type = compute_type.strip() or "int8"
    language = None if language.strip() in ("", "auto") else language.strip()

    try:
        from faster_whisper import WhisperModel
    except Exception as exc:  # noqa: BLE001 - reported to the renderer as-is
        emit({"ok": False, "error": "faster_whisper unavailable: %s" % exc})
        return 3

    try:
        model = WhisperModel(model_name, device=device, compute_type=compute_type)
        segments, info = model.transcribe(
            audio_path,
            language=language,
            vad_filter=True,
            beam_size=5,
            condition_on_previous_text=False,
        )
        text = "".join(segment.text for segment in segments).strip()
        emit({
            "ok": True,
            "transcript": text,
            "language": getattr(info, "language", None),
            "duration": round(float(getattr(info, "duration", 0.0) or 0.0), 2),
        })
        return 0
    except Exception as exc:  # noqa: BLE001
        emit({"ok": False, "error": str(exc) or exc.__class__.__name__})
        return 4


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
