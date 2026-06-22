#!/usr/bin/env python3
"""Persistent Silero VAD worker for Floki chat.local.

Input: newline-delimited JSON with base64-encoded little-endian PCM16 mono frames.
Output: newline-delimited JSON with one speech probability per frame.
The Silero model is loaded exactly once for the lifetime of the worker.
"""

import base64
import json
import os
import sys

import numpy as np
import torch
from silero_vad import load_silero_vad

SAMPLE_RATE = int(os.environ.get("FLOKI_VAD_SAMPLE_RATE", "16000"))


def emit(payload):
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main():
    model = load_silero_vad()
    model.reset_states()
    emit({"ok": True, "type": "ready", "sample_rate": SAMPLE_RATE})

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
            command = message.get("command")
            if command == "reset":
                model.reset_states()
                emit({"ok": True, "type": "reset"})
                continue
            if command == "stop":
                emit({"ok": True, "type": "stopped"})
                return

            pcm = base64.b64decode(message["pcm16_base64"])
            samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
            tensor = torch.from_numpy(samples)
            probability = float(model(tensor, SAMPLE_RATE).item())
            emit({
                "ok": True,
                "type": "probability",
                "sequence": int(message.get("sequence", 0)),
                "probability": probability,
            })
        except Exception as error:
            emit({"ok": False, "type": "error", "error": str(error)})


if __name__ == "__main__":
    main()
