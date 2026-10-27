#!/usr/bin/env python3
"""Probe a Python environment for the voice stack (faster-whisper + edge-tts).

Prints one JSON object: {"faster_whisper": "<version>"|null, "edge_tts": "<version>"|null}.
"""

import json


from typing import Optional


def main():
    result: dict[str, Optional[str]] = {"faster_whisper": None, "edge_tts": None}
    for module_name in ("faster_whisper", "edge_tts"):
        try:
            module = __import__(module_name)
            result[module_name] = getattr(module, "__version__", "unknown") or "unknown"
        except Exception:
            result[module_name] = None
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
