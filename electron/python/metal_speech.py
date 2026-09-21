"""Qwen3-ASR adapter: an owned, loopback-only vLLM Metal server.

Shares the load/status/transcribe/unload contract with the CUDA worker. Audio
never leaves the machine; a per-process API key protects the local endpoint.
"""
from __future__ import annotations

import io
import json
import os
import secrets
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import wave
from pathlib import Path

MODEL = "Qwen/Qwen3-ASR-0.6B"


class MetalSpeech:
    def __init__(self):
        self.process = None
        self.endpoint = None
        self.key = secrets.token_urlsafe(32)
        self.log = None
        self.http = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def _watch(self, process):
        while self.process is process:
            if process.poll() is not None:
                if self.process is not process:
                    return
                print("Qwen3-ASR server exited unexpectedly. Load the model to restart it.", file=sys.stderr, flush=True)
                # The Electron worker supervisor resets readiness and releases
                # the whole process group, including any remaining descendants.
                os._exit(1)
            time.sleep(1)

    def status(self):
        return {"loaded": self.process is not None and self.process.poll() is None,
                "model": MODEL, "device": "mlx"}

    def _request(self, path, data=None, content_type=None, timeout=10):
        headers = {"Authorization": "Bearer " + self.key}
        if content_type:
            headers["Content-Type"] = content_type
        request = urllib.request.Request(self.endpoint + path, data=data, headers=headers)
        try:
            with self.http.open(request, timeout=timeout) as response:
                raw = response.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            detail = exc.read(4096).decode("utf-8", errors="replace")
            raise RuntimeError(f"Qwen3-ASR endpoint failed ({exc.code}): {detail}") from exc

    def load(self, request):
        if self.status()["loaded"]:
            self._request("/health")
            return self.status()
        self.unload()
        # Reserve a free loopback port. A collision after closing is detected by
        # server exit; authentication prevents accidentally using another server.
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        self.endpoint = f"http://127.0.0.1:{port}"
        self.log = tempfile.TemporaryFile(mode="w+b")
        self.process = subprocess.Popen(
            [sys.executable, "-m", "vllm.entrypoints.cli.main", "serve", MODEL,
             "--host", "127.0.0.1", "--port", str(port)],
            stdin=subprocess.DEVNULL, stdout=self.log, stderr=self.log,
            env={**os.environ, "VLLM_API_KEY": self.key, "VLLM_NO_USAGE_STATS": "1", "DO_NOT_TRACK": "1"},
        )
        deadline = time.monotonic() + 25 * 60
        log_offset = 0
        try:
            while time.monotonic() < deadline:
                output = os.pread(self.log.fileno(), 16384, log_offset)
                if output:
                    log_offset += len(output)
                    lines = output.decode(errors="replace").strip().splitlines()
                    detail = lines[-1][-350:] if lines else "Loading Qwen3-ASR…"
                    # sys.stdout is redirected to stderr by the request loop.
                    sys.__stdout__.write("@delulu-progress:" + detail + "\n")
                    sys.__stdout__.flush()
                if self.process.poll() is not None:
                    self.log.seek(0, 2)
                    self.log.seek(max(0, self.log.tell() - 12000))
                    raise RuntimeError("Qwen3-ASR server stopped: " + self.log.read().decode(errors="replace"))
                try:
                    self._request("/health", timeout=2)
                    break
                except (OSError, RuntimeError):
                    time.sleep(0.5)
            else:
                raise TimeoutError("Qwen3-ASR download/startup timed out. Check your connection and retry Repair.")
            wav = io.BytesIO()
            with wave.open(wav, "wb") as audio:
                audio.setnchannels(1)
                audio.setsampwidth(2)
                audio.setframerate(16000)
                audio.writeframes(b"\0\0" * 16000)
            self._transcribe(wav.getvalue(), timeout=120)
            threading.Thread(target=self._watch, args=(self.process,), daemon=True).start()
            return self.status()
        except BaseException:
            self.unload()
            raise

    def _transcribe(self, audio, timeout):
        boundary = "delulu-" + secrets.token_hex(16)
        body = bytearray()
        for name, value in (("model", MODEL), ("response_format", "json")):
            body.extend(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode())
        body.extend(f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"recording.wav\"\r\nContent-Type: audio/wav\r\n\r\n".encode())
        body.extend(audio)
        body.extend(f"\r\n--{boundary}--\r\n".encode())
        return self._request("/v1/audio/transcriptions", bytes(body), "multipart/form-data; boundary=" + boundary, timeout)

    def transcribe(self, request):
        if not self.status()["loaded"]:
            raise RuntimeError("Qwen3-ASR is not running. Load the model to try again.")
        started = time.perf_counter()
        audio = Path(request["audioPath"])
        with wave.open(str(audio), "rb") as wav:
            duration = wav.getnframes() / wav.getframerate()
        result = self._transcribe(audio.read_bytes(), timeout=min(900, max(120, duration * 3)))
        if not isinstance(result, dict) or not isinstance(result.get("text"), str):
            raise RuntimeError("Qwen3-ASR returned an invalid transcription response")
        language = str(result.get("language") or "und").lower()
        from transcription_engine import LANGUAGE_NAMES
        language = {name.lower(): code for code, name in LANGUAGE_NAMES.items()}.get(language, language)
        elapsed = time.perf_counter() - started
        return {"text": result["text"].strip(), "language": language,
                "duration": duration, "processingTime": elapsed,
                "inferenceTime": elapsed}

    def unload(self):
        process, self.process = self.process, None
        if process is not None:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
        if self.log is not None:
            self.log.close()
            self.log = None
        self.endpoint = None
        return {"loaded": False}
