"""Opt-in real inference smoke check. Run with the app's venv Python and --cache.
Uses only pre-downloaded models; never prints transcript contents or modifies source audio.
Requires Apple Silicon for MLX or an NVIDIA CUDA GPU for Linux vLLM / Windows PyTorch.
"""
import argparse
import hashlib
import importlib.metadata
import json
import os
import signal
import sys
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "electron/python"))
from worker_protocol import PROTOCOL_VERSION, terminal_response, validate_progress, validate_request

MAX_REQUEST_BYTES = 4 * 1024 * 1024
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
PROTOCOL_PREFIX = b"@delulu:"
PROGRESS_PREFIX = b"@delulu-progress:"
PROTOCOL_REPAIR = "Repair the local runtime and restart the app before retrying the smoke check."


class SmokeWorker:
    """Exercise the same versioned JSON-lines entrypoint as the desktop client."""

    def __init__(self, script):
        self.failed = False
        self.child = subprocess.Popen(
            [sys.executable, "-u", str(script)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=None,
            env=os.environ.copy(),
            start_new_session=os.name != "nt",
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
        )

    def _send(self, request):
        request_id = str(uuid.uuid4())
        envelope = {**request, "id": request_id, "protocolVersion": PROTOCOL_VERSION}
        validate_request(envelope)
        encoded = json.dumps(envelope, ensure_ascii=False, allow_nan=False).encode("utf8")
        if len(encoded) > MAX_REQUEST_BYTES:
            raise RuntimeError("Smoke request exceeds the 4 MiB worker protocol limit.")
        self.child.stdin.write(encoded + b"\n")
        self.child.stdin.flush()
        return request_id

    def _receive(self, request_id, command):
        def invalid_constant(value):
            raise ValueError(f"Invalid JSON constant: {value}")

        while True:
            line = self.child.stdout.readline(MAX_RESPONSE_BYTES + 3)
            if not line:
                raise RuntimeError(f"Model worker closed before its terminal response. {PROTOCOL_REPAIR}")
            content = line.removesuffix(b"\n").removesuffix(b"\r")
            if len(content) > MAX_RESPONSE_BYTES:
                raise RuntimeError(f"Model worker stdout exceeds the 8 MiB protocol limit. {PROTOCOL_REPAIR}")
            if content.startswith(PROGRESS_PREFIX):
                try:
                    event = validate_progress(json.loads(
                        content[len(PROGRESS_PREFIX):], parse_constant=invalid_constant,
                    ))
                except (ValueError, UnicodeDecodeError) as error:
                    raise RuntimeError(f"Invalid model worker progress event. {PROTOCOL_REPAIR}") from error
                if event["id"] != request_id or event["command"] != command:
                    continue
                # Progress belongs to this operation, but never completes it.
                continue
            if not content.startswith(PROTOCOL_PREFIX):
                continue
            try:
                response = json.loads(content[len(PROTOCOL_PREFIX):], parse_constant=invalid_constant)
            except (ValueError, UnicodeDecodeError) as error:
                raise RuntimeError(f"Invalid model worker terminal response. {PROTOCOL_REPAIR}") from error
            if not isinstance(response, dict):
                raise RuntimeError(f"Invalid model worker terminal envelope. {PROTOCOL_REPAIR}")
            version = response.get("protocolVersion")
            if type(version) is not int or version != PROTOCOL_VERSION:
                raise RuntimeError(
                    f"Model worker protocol version mismatch: expected {PROTOCOL_VERSION}, received {version!r}. {PROTOCOL_REPAIR}"
                )
            if response.get("id") != request_id or type(response.get("ok")) is not bool:
                raise RuntimeError(f"Model worker terminal envelope does not match the request. {PROTOCOL_REPAIR}")
            try:
                terminal_response(response, command)
            except ValueError as error:
                raise RuntimeError(f"Invalid model worker terminal schema. {PROTOCOL_REPAIR}") from error
            if not response["ok"]:
                raise RuntimeError(response["error"])
            return response["result"]

    def dispatch(self, request):
        try:
            return self._receive(self._send(request), request["command"])
        except Exception:
            self.failed = True
            raise

    def _terminate(self, force=False):
        if os.name == "nt":
            # Best effort for the owned tree while Windows still knows its leader.
            try:
                subprocess.run(
                    ["taskkill", "/PID", str(self.child.pid), "/T", "/F"],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    timeout=5, check=False,
                )
            except (OSError, subprocess.TimeoutExpired):
                if self.child.poll() is None:
                    self.child.kill()
        else:
            try:
                os.killpg(self.child.pid, signal.SIGKILL if force else signal.SIGTERM)
            except ProcessLookupError:
                return
            if force:
                return
            # The session belongs to this smoke run, even after its leader exits.
            # Waiting only for Popen would leave vLLM descendants alive.
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                self.child.poll()
                try:
                    os.killpg(self.child.pid, 0)
                except ProcessLookupError:
                    return
                time.sleep(0.05)
            self._terminate(force=True)

    def close(self):
        try:
            if not self.failed and self.child.poll() is None:
                request_id = self._send({"command": "shutdown"})
                self.child.stdin.close()
                self.child.wait(timeout=10)
                # Release inherited stdout handles before reading the final frame.
                self._terminate()
                self._receive(request_id, "shutdown")
        finally:
            self._terminate()
            try:
                self.child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._terminate(force=True)
                self.child.wait(timeout=5)
            self.child.stdout.close()
            if not self.child.stdin.closed:
                self.child.stdin.close()

parser = argparse.ArgumentParser()
parser.add_argument("--cache", required=True)
parser.add_argument("--magic", action="store_true")
args = parser.parse_args()
os.environ.update({"HF_HUB_OFFLINE": "1", "HF_HOME": args.cache, "HF_HUB_CACHE": str(Path(args.cache) / "hub")})
worker = SmokeWorker(root / "electron/python/transcription_engine.py")
report = {}
try:
    start = time.monotonic()
    worker.dispatch({"command": "load", "cacheDir": args.cache})
    report["speechLoadSeconds"] = round(time.monotonic() - start, 2)
    with tempfile.TemporaryDirectory(prefix="delulu-smoke-") as temporary:
        wav = str(Path(temporary) / "sample.wav")
        subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-i", str(root / "test-audio.m4a"), "-ar", "16000", "-ac", "1", wav], check=True)
        result = worker.dispatch({"command": "transcribe", "audioPath": wav, "language": "en"})
        assert result["text"].strip(), "Missing transcript"
        report["speech"] = {"characters": len(result["text"]), "processingSeconds": round(result["processingTime"], 2)}
    if args.magic:
        worker.dispatch({"command": "magicLoad", "model": "qwen35Medium", "cacheDir": args.cache})
        result = worker.dispatch({"command": "magicRewrite", "text": "um please move the design review to Thursday", "preset": "polish", "allowInferences": False})
        assert result["text"].strip(), "Missing Magic output"
        assert "Thursday" in result["text"], "Magic lost the requested day"
        report["magic"] = {"characters": len(result["text"]), "processingTimeMs": result["processingTimeMs"]}
    evidence_path = os.environ.get("DELULU_EVIDENCE_NATIVE_RESULT")
    if evidence_path:
        speech = worker.dispatch({"command": "status"})
        versions = {}
        for package in ("mlx", "mlx-audio", "torch", "transformers", "vllm", "qwen-asr"):
            try:
                versions[package] = importlib.metadata.version(package)
            except importlib.metadata.PackageNotFoundError:
                pass
        observation = {
            "model": speech["model"], "modelSource": "worker status", "device": speech["device"],
            "backend": "mlx" if speech["device"] == "mlx" else "cuda-transformers" if sys.platform == "win32" else "cuda-vllm",
            "backendSource": "worker device and platform",
            "fixtureSha256": hashlib.sha256((root / "test-audio.m4a").read_bytes()).hexdigest(),
            "characters": report["speech"]["characters"],
            "pythonVersion": sys.version, "packageVersions": versions,
            "measurements": report,
        }
        Path(evidence_path).write_text(json.dumps(observation), encoding="utf8")
    print(json.dumps(report, indent=2))
finally:
    worker.close()
