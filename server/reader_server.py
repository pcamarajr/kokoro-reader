#!/usr/bin/env python3
"""Local Kokoro TTS server for the Kokoro Reader Chrome extension.

Listens on 127.0.0.1 only. One sentence per request; the extension prefetches
ahead so playback never waits. Returns WAV audio plus per-word timestamps so
the page can highlight the word being spoken.

    POST /speak   {"text": "...", "voice": "af_heart", "speed": 1.0}
                  -> {"audio": <base64 wav>, "duration": s, "words": [{"t","s","e"}]}
    POST /warm    load the model now, so the first sentence is not slow
    GET  /health  {"ok": true, "loaded": bool}

Only the extension can call it: every request must carry an Origin of
chrome-extension://..., and CORS preflights are refused, so ordinary web pages
cannot reach it even though it is on localhost.

The model (~1.5 GB resident) is imported lazily and the process exits after
IDLE_TIMEOUT seconds without requests; launchd restarts it cheaply, without
the model, and it loads again on the next request.
"""
import base64
import io
import json
import os
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

HOST = "127.0.0.1"
PORT = int(os.environ.get("KOKORO_READER_PORT", 51730))
IDLE_TIMEOUT = float(os.environ.get("KOKORO_READER_IDLE", 1800))
SR = 24000
MAX_TEXT = 2000

# Pause appended after a sentence, by its final punctuation. Kokoro pads every
# chunk with ~0.3-0.8 s of silence; we trim that and put back something closer
# to natural reading rhythm.
PAUSE = {".": 0.30, "!": 0.30, "?": 0.30, ":": 0.25, ";": 0.22, ",": 0.12}
DEFAULT_PAUSE = 0.35          # headings and list items usually lack punctuation
SILENCE_THRESHOLD = 0.01
KEEP_MARGIN = 0.03

_model_lock = threading.Lock()
_pipelines = {}
_last_used = time.time()


def log(msg):
    sys.stderr.write(f"[{time.strftime('%H:%M:%S')}] {msg}\n")
    sys.stderr.flush()


def get_pipeline(lang):
    """KPipeline for a language code ('a' US English, 'b' UK, 'p' pt-BR...)."""
    if lang not in _pipelines:
        t0 = time.time()
        from kokoro import KPipeline          # heavy: pulls in torch
        # Every pipeline shares one model instance.
        model = next(iter(_pipelines.values())).model if _pipelines else True
        _pipelines[lang] = KPipeline(lang_code=lang, repo_id="hexgrad/Kokoro-82M",
                                     model=model)
        log(f"pipeline '{lang}' loaded in {time.time() - t0:.1f}s")
    return _pipelines[lang]


def synthesize(text, voice, speed):
    """Return (float32 audio, [{"t": word, "s": start, "e": end}, ...])."""
    pipeline = get_pipeline(voice[0])
    pieces, words, offset = [], [], 0.0
    for result in pipeline(text, voice=voice, speed=speed, split_pattern=None):
        if result.audio is None:
            continue
        audio = result.audio.numpy().astype(np.float32).reshape(-1)
        for tok in result.tokens or []:
            if tok.start_ts is None or tok.end_ts is None:
                continue
            if not any(c.isalnum() for c in tok.text):
                continue
            words.append({"t": tok.text, "s": offset + tok.start_ts,
                          "e": offset + tok.end_ts})
        pieces.append(audio)
        offset += len(audio) / SR
    if not pieces:
        return np.zeros(0, np.float32), []
    audio = np.concatenate(pieces)

    # Trim leading/trailing silence, shifting timestamps by the lead cut.
    loud = np.nonzero(np.abs(audio) > SILENCE_THRESHOLD)[0]
    if len(loud):
        margin = int(KEEP_MARGIN * SR)
        start = max(0, loud[0] - margin)
        end = min(len(audio), loud[-1] + margin)
        audio = audio[start:end]
        shift = start / SR
        limit = len(audio) / SR
        for w in words:
            w["s"] = round(max(0.0, w["s"] - shift), 3)
            w["e"] = round(min(limit, max(w["s"], w["e"] - shift)), 3)

    pause = PAUSE.get(text.rstrip()[-1:], DEFAULT_PAUSE) / max(speed, 0.5)
    audio = np.concatenate([audio, np.zeros(int(pause * SR), np.float32)])
    return audio, words


def to_wav(audio):
    pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    server_version = "KokoroReader/1"

    def log_message(self, fmt, *args):   # quiet default access log
        pass

    def _allowed(self):
        return self.headers.get("Origin", "").startswith("chrome-extension://")

    def _send(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):                # refuse every CORS preflight
        self.send_response(403)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, {"ok": True, "loaded": bool(_pipelines)})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        global _last_used
        if not self._allowed():
            return self._send(403, {"error": "forbidden"})
        _last_used = time.time()
        try:
            length = min(int(self.headers.get("Content-Length", 0)), 64 * 1024)
            req = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, OSError):
            return self._send(400, {"error": "bad json"})

        voice = str(req.get("voice") or "af_heart")
        if not voice.replace("_", "").isalnum() or len(voice) > 32:
            return self._send(400, {"error": "bad voice"})
        try:
            speed = min(2.0, max(0.5, float(req.get("speed", 1.0))))
        except (TypeError, ValueError):
            speed = 1.0

        if self.path == "/warm":
            with _model_lock:
                get_pipeline(voice[0])
                pipeline = _pipelines[voice[0]]
                pipeline.load_voice(voice)
            return self._send(200, {"ok": True})

        if self.path != "/speak":
            return self._send(404, {"error": "not found"})
        text = str(req.get("text", "")).strip()[:MAX_TEXT]
        if not text:
            return self._send(400, {"error": "empty text"})
        t0 = time.time()
        try:
            with _model_lock:            # the model is not thread-safe
                audio, words = synthesize(text, voice, speed)
        except Exception as exc:         # noqa: BLE001 - report to the client
            log(f"synthesis failed: {exc!r}")
            return self._send(500, {"error": str(exc)})
        _last_used = time.time()
        duration = len(audio) / SR
        log(f"{len(text):4d} chars -> {duration:5.1f}s audio in {time.time() - t0:.2f}s")
        self._send(200, {
            "audio": base64.b64encode(to_wav(audio)).decode(),
            "duration": duration,
            "words": words,
        })


def reaper():
    while True:
        time.sleep(30)
        if _pipelines and time.time() - _last_used > IDLE_TIMEOUT:
            log("idle, exiting to free memory")
            os._exit(0)


def main():
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    threading.Thread(target=reaper, daemon=True).start()
    log(f"listening on http://{HOST}:{PORT}")
    srv.serve_forever()


if __name__ == "__main__":
    main()
