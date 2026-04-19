#!/usr/bin/env python3
"""
STT daemon for Thamma.
Uses mlx-whisper for fully local, offline speech-to-text.
TTS is handled by macOS `say` directly in main.js — no neural TTS.

Protocol (newline-delimited JSON, stdin → stdout):
  stdin  → {"type":"transcribe","audio":"<base64 webm/ogg>"}
  stdout → {"type":"transcription","text":"..."}
  stderr → human-readable logs; "READY" line tells main.js the daemon is up.
"""

import sys
import os
import json
import base64
import tempfile
import threading
import queue as _queue

_stdout_lock = threading.Lock()


def _write_json(obj: dict):
    line = json.dumps(obj, separators=(',', ':')) + '\n'
    with _stdout_lock:
        sys.stdout.write(line)
        sys.stdout.flush()


# ── Load mlx-whisper ──────────────────────────────────────────────────────────
sys.stderr.write('[stt] Loading mlx-whisper...\n')
sys.stderr.flush()

try:
    import mlx_whisper
    HAS_WHISPER = True
    sys.stderr.write('[stt] mlx-whisper loaded ✓\n')
except ImportError as e:
    HAS_WHISPER = False
    sys.stderr.write(f'[stt] mlx-whisper not available: {e}\n')
    sys.stderr.write('[stt] Wake word detection disabled. Install: pip install mlx-whisper\n')
sys.stderr.flush()

WHISPER_REPO = 'mlx-community/whisper-tiny.en-mlx'


def _transcribe(audio_b64: str) -> str:
    """Transcribe base64-encoded WebM/OGG audio via mlx-whisper."""
    if not HAS_WHISPER:
        return ''
    tmp = None
    try:
        raw = base64.b64decode(audio_b64)
        with tempfile.NamedTemporaryFile(suffix='.webm', delete=False) as f:
            f.write(raw)
            tmp = f.name
        result = mlx_whisper.transcribe(
            tmp,
            path_or_hf_repo=WHISPER_REPO,
            language='en',
            initial_prompt='Hey Thamma, ',
        )
        return (result.get('text', '') or '').strip()
    except Exception as exc:
        sys.stderr.write(f'[stt] transcribe error: {exc}\n')
        sys.stderr.flush()
        return ''
    finally:
        if tmp:
            try:
                os.unlink(tmp)
            except Exception:
                pass


# ── Worker thread ─────────────────────────────────────────────────────────────
# Serialises transcription so the stdin loop never blocks, and so concurrent
# mlx_whisper calls never compete for the MLX computation graph.
_work_q: '_queue.Queue[str | None]' = _queue.Queue()


def _worker():
    """Process transcription requests one at a time, in arrival order."""
    while True:
        item = _work_q.get()
        if item is None:    # shutdown sentinel
            break
        text = _transcribe(item)
        _write_json({'type': 'transcription', 'text': text})


threading.Thread(target=_worker, daemon=True, name='stt-worker').start()


# ── Signal ready ──────────────────────────────────────────────────────────────
sys.stderr.write('READY\n')
sys.stderr.flush()


# ── Main stdin loop ───────────────────────────────────────────────────────────
_in_buf = ''
for _raw in sys.stdin:
    _in_buf += _raw
    while '\n' in _in_buf:
        _line, _in_buf = _in_buf.split('\n', 1)
        _line = _line.strip()
        if not _line:
            continue
        try:
            _cmd = json.loads(_line)
        except json.JSONDecodeError:
            continue

        if _cmd.get('type') == 'transcribe':
            _work_q.put(_cmd.get('audio', ''))
        # All other types (audio_frame, control, synthesize) are silently ignored.
        # They may arrive if the renderer is ahead of the daemon version — safe to discard.
