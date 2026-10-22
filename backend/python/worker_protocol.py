"""Versioned worker envelopes and command schemas, without model dependencies."""

from __future__ import annotations

import contextlib
from contextvars import ContextVar
import json
import math
import os
import sys
from typing import Any, TextIO


PROTOCOL_VERSION = 1
MAX_ID_BYTES = 128
MAX_COMMAND_BYTES = 64
# Comma-separated vocabulary terms for R2T2 recognition hints.
MAX_HOTWORDS_CHARS = 3000
MAX_ERROR_BYTES = 8_000
PROGRESS_PREFIX = "@delulu-progress:"
MAX_PROGRESS_STAGE_BYTES = 64
MAX_PROGRESS_DETAIL_BYTES = 4_000
MAX_PROGRESS_LINE_BYTES = 32_768
_active_operation: ContextVar[tuple[str, str] | None] = ContextVar("worker_operation", default=None)
COMMANDS = frozenset({
    "status", "load", "unload", "magicStatus", "magicLoad",
    "magicRewrite", "transcribe", "shutdown", "capabilities",
    "voiceStatus", "voiceLoad", "voiceUnload", "voiceSynthesize",
})
# Spoken output (src/voice.ts is the shared source of truth for these names).
VOICE_ENGINES = frozenset({"kokoro", "chatterbox-turbo"})
VOICE_EVENT_TAGS = frozenset({
    "laugh", "chuckle", "sigh", "gasp", "cough", "clear-throat", "sniff", "groan", "shush",
})
VOICE_STYLES = frozenset({
    "whisper", "happy", "angry", "surprised", "scared", "sarcastic", "dramatic", "narration",
    "crying", "slow", "fast", "soft", "loud", "emphasis",
})
MAX_VOICE_TEXT_CHARS = 600
MAX_VOICE_PARTS = 200
MAX_VOICE_PAUSE_MS = 5_000
MAX_VOICE_STYLES = 8
MAX_VOICE_NAME_BYTES = 64
MAX_VOICE_REFERENCE_BYTES = 4096
MAX_VOICE_UNSUPPORTED = 32
MIN_VOICE_SPEED = 0.25
MAX_VOICE_SPEED = 4.0
VOICE_PART_FIELDS = {"text": frozenset({"kind", "text"}), "event": frozenset({"kind", "tag"}),
                     "pause": frozenset({"kind", "ms"})}
SPEECH_MODELS = frozenset({"r2t2", "canary-180m", "parakeet-v2", "parakeet-v3"})
MAGIC_PRESETS = frozenset({"spoken-corrections", "polish", "concise", "structured", "prompt", "bullet-points", "professional-message"})
MAGIC_MODELS = frozenset({"qwen35Small", "qwen35Medium", "qwen35Large"})
# Keep aligned with the shared PipelineTimings contract; unknown stages are omitted.
TIMING_FIELDS = frozenset({
    "captureEndMs", "preprocessingMs", "speechLoadMs", "speechRequestMs",
    "backendPreprocessingMs", "inferenceMs", "rewriteLoadMs", "rewritingMs",
    "clipboardMs", "pasteMs",
})


@contextlib.contextmanager
def operation_scope(request_id: str, command: str):
    if not bounded_string(request_id, MAX_ID_BYTES) or not bounded_string(command, MAX_COMMAND_BYTES):
        raise ValueError("Worker operation requires a valid request id and command")
    token = _active_operation.set((request_id, command))
    try:
        yield
    finally:
        _active_operation.reset(token)


def validate_progress(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("Worker progress must be an object")
    if type(value.get("protocolVersion")) is not int or value["protocolVersion"] != PROTOCOL_VERSION:
        raise ValueError("Worker progress protocolVersion must be integer 1")
    if value.get("type") != "progress":
        raise ValueError("Worker progress type must be progress")
    for key, limit in (("id", MAX_ID_BYTES), ("command", MAX_COMMAND_BYTES),
                       ("stage", MAX_PROGRESS_STAGE_BYTES)):
        if not bounded_string(value.get(key), limit):
            raise ValueError(f"Worker progress {key} must be a nonempty bounded UTF-8 string")
    require_string(value, "detail")
    try:
        valid_detail = len(value["detail"].encode("utf-8")) <= MAX_PROGRESS_DETAIL_BYTES
    except UnicodeEncodeError:
        valid_detail = False
    if not valid_detail:
        raise ValueError("Worker progress detail exceeds its UTF-8 byte limit")
    if "fraction" in value:
        require_number(value, "fraction")
        if value["fraction"] > 1:
            raise ValueError("Worker progress fraction must be between 0 and 1")
    if "downloadBytes" in value:
        download = value["downloadBytes"]
        if not isinstance(download, dict) or "total" not in download:
            raise ValueError("Worker downloadBytes must contain completed, total and kind")
        if download.get("kind") not in ("transfer", "reconstruction"):
            raise ValueError("Worker downloadBytes kind must be transfer or reconstruction")
        for key in ("completed", "total"):
            if key == "total" and download[key] is None:
                continue
            require_number(download, key)
            number = download[key]
            if number > 2**53 - 1 or number != int(number):
                raise ValueError(f"Worker downloadBytes {key} must be a safe integer")
        if download["total"] is not None and download["completed"] > download["total"]:
            raise ValueError("Worker downloadBytes total cannot be below completed")
    validate_json_value(value)
    return value


def emit_progress(detail: str, stage: str = "load", fraction: float | None = None,
                  *, download_bytes: dict[str, Any] | None = None) -> None:
    operation = _active_operation.get()
    if operation is None:
        # Direct adapter calls are diagnostics, without a desktop request owner.
        sys.stderr.write(str(detail) + "\n")
        sys.stderr.flush()
        return
    request_id, command = operation
    payload = {"protocolVersion": PROTOCOL_VERSION, "type": "progress", "id": request_id,
               "command": command, "stage": stage, "detail": detail}
    if fraction is not None:
        payload["fraction"] = fraction
    if download_bytes is not None:
        payload["downloadBytes"] = download_bytes
    validate_progress(payload)
    line = PROGRESS_PREFIX + json.dumps(payload, ensure_ascii=False, allow_nan=False)
    if len(line.encode("utf-8")) > MAX_PROGRESS_LINE_BYTES:
        raise ValueError("Worker progress line exceeds its byte limit")
    stream = protocol_stream()
    stream.write(line + "\n")
    stream.flush()


def capture_progress_emitter():
    """Bind callbacks to their request, even when a download runs in threads."""
    operation = _active_operation.get()

    def emit(detail: str, stage: str = "load", fraction: float | None = None,
             *, download_bytes: dict[str, Any] | None = None) -> None:
        if operation is None:
            return
        with operation_scope(*operation):
            emit_progress(detail, stage, fraction, download_bytes=download_bytes)

    return emit


def validate_json_value(value: Any, depth: int = 0) -> None:
    if depth > 64:
        raise ValueError("Worker JSON exceeds 64 nesting levels")
    if value is None or type(value) in (str, bool):
        return
    if type(value) in (int, float):
        try:
            if math.isfinite(value):
                return
        except OverflowError:
            pass
    elif isinstance(value, (dict, list)):
        items = value.values() if isinstance(value, dict) else value
        for item in items:
            validate_json_value(item, depth + 1)
        return
    raise ValueError("Worker payload must contain finite JSON values")


def utf16_length(value: str) -> int:
    """Match JavaScript string length for transport character limits."""
    return len(value.encode("utf-16-le", errors="surrogatepass")) // 2


def bounded_string(value: Any, limit: int) -> bool:
    if not isinstance(value, str) or not value:
        return False
    try:
        return len(value.encode("utf-8")) <= limit
    except UnicodeEncodeError:
        return False


def correlation_id(request: Any) -> str | None:
    """Only echo identifiers the desktop can safely correlate."""
    value = request.get("id") if isinstance(request, dict) else None
    return value if bounded_string(value, MAX_ID_BYTES) else None


def require_string(value: dict[str, Any], key: str, *, nonempty: bool = False) -> None:
    field = value.get(key)
    if not isinstance(field, str) or (nonempty and not field):
        raise ValueError(f"Worker field {key} must be {'a nonempty' if nonempty else 'a'} string")


def require_boolean(value: dict[str, Any], key: str) -> None:
    if type(value.get(key)) is not bool:
        raise ValueError(f"Worker field {key} must be a boolean")


def require_number(value: dict[str, Any], key: str, *, integer: bool = False) -> None:
    field = value.get(key)
    valid = type(field) is int if integer else type(field) in (int, float)
    try:
        valid = valid and math.isfinite(field) and field >= 0
    except (OverflowError, TypeError):
        valid = False
    if not valid:
        kind = "integer" if integer else "number"
        raise ValueError(f"Worker field {key} must be a finite nonnegative {kind}")


def validate_request(request: Any) -> dict[str, Any]:
    if not isinstance(request, dict):
        raise ValueError("Worker request must be a JSON object")
    if type(request.get("protocolVersion")) is not int or request["protocolVersion"] != PROTOCOL_VERSION:
        raise ValueError("Unsupported worker protocolVersion; expected integer 1. Repair the runtime and retry")
    if correlation_id(request) is None:
        raise ValueError("Worker request id must be a nonempty string of at most 128 UTF-8 bytes")
    command = request.get("command")
    if not bounded_string(command, MAX_COMMAND_BYTES):
        raise ValueError("Worker command must be a nonempty string of at most 64 UTF-8 bytes")
    if command not in COMMANDS:
        raise ValueError(f"Unknown worker command: {command}")
    validate_json_value(request)
    if command == "capabilities":
        if request.get("engine") not in ("speech", "writing"):
            raise ValueError("Worker capabilities engine must be speech or writing")
        if "model" in request:
            require_string(request, "model")
            if request["model"] not in SPEECH_MODELS:
                raise ValueError(f"Unsupported speech model: {request['model']}")
    if command in ("load", "magicLoad", "voiceLoad") and "cacheDir" in request:
        require_string(request, "cacheDir")
    if command in ("voiceLoad", "voiceSynthesize"):
        if request.get("engine") not in VOICE_ENGINES:
            raise ValueError("Unsupported voice engine")
    if command == "voiceLoad" and "device" in request and request["device"] not in ("auto", "cpu"):
        raise ValueError("Unsupported voice device preference")
    if command == "voiceSynthesize":
        validate_voice_synthesis(request)
    if command == "load" and "device" in request and request["device"] not in ("auto", "cpu"):
        raise ValueError("Unsupported speech device preference")
    if command == "load" and "language" in request:
        require_string(request, "language")
    if command in ("load", "transcribe") and "model" in request:
        require_string(request, "model")
        if request["model"] not in SPEECH_MODELS:
            raise ValueError(f"Unsupported speech model: {request['model']}")
    if command == "magicLoad" and "model" in request:
        require_string(request, "model")
        if request["model"] not in MAGIC_MODELS:
            raise ValueError(f"Unsupported Magic model: {request['model']}")
    if command == "transcribe":
        require_string(request, "audioPath", nonempty=True)
        if "language" in request:
            require_string(request, "language")
        if "hotwords" in request:
            require_string(request, "hotwords")
            if len(request["hotwords"]) > MAX_HOTWORDS_CHARS:
                raise ValueError(f"Speech hotwords exceed {MAX_HOTWORDS_CHARS} characters")
        if "durationMs" in request:
            require_number(request, "durationMs")
        for control in ("timestamps", "vocabularyBiasing"):
            if control in request:
                require_boolean(request, control)
                if request[control]:
                    raise ValueError(f"The current speech pipeline does not support {control}")
    if command == "magicRewrite":
        require_string(request, "text")
        if utf16_length(request["text"]) > 500_000:
            raise ValueError("Worker Magic text exceeds the 500,000 character protocol limit")
        if "preset" in request:
            require_string(request, "preset")
            if request["preset"] not in MAGIC_PRESETS:
                raise ValueError(f"Unsupported Magic preset: {request['preset']}")
        if "instructions" in request:
            require_string(request, "instructions")
            if utf16_length(request["instructions"]) > 4_000:
                raise ValueError("Worker Magic instructions exceed the 4,000 character limit")
        if "allowInferences" in request:
            require_boolean(request, "allowInferences")
    return request


def validate_voice_synthesis(request: dict[str, Any]) -> None:
    if not bounded_string(request.get("voice"), MAX_VOICE_NAME_BYTES):
        raise ValueError("Voice name must be a nonempty string of at most 64 UTF-8 bytes")
    if "reference" in request and not bounded_string(request["reference"], MAX_VOICE_REFERENCE_BYTES):
        raise ValueError("Voice reference must be a nonempty path of at most 4096 UTF-8 bytes")
    require_number(request, "speed")
    if not MIN_VOICE_SPEED <= request["speed"] <= MAX_VOICE_SPEED:
        raise ValueError("Voice speed must be between 0.25 and 4")
    styles = request.get("styles")
    if (not isinstance(styles, list) or len(styles) > MAX_VOICE_STYLES
            or any(type(style) is not str or style not in VOICE_STYLES for style in styles)
            or len(set(styles)) != len(styles)):
        raise ValueError("Voice styles must be at most 8 unique known style names")
    parts = request.get("parts")
    if not isinstance(parts, list) or not parts or len(parts) > MAX_VOICE_PARTS:
        raise ValueError("Voice synthesis needs between 1 and 200 parts")
    characters = 0
    for part in parts:
        if not isinstance(part, dict) or part.get("kind") not in VOICE_PART_FIELDS:
            raise ValueError("Voice part kind must be text, event or pause")
        if set(part) != VOICE_PART_FIELDS[part["kind"]]:
            raise ValueError("Voice part has missing or unexpected fields")
        if part["kind"] == "text":
            require_string(part, "text")
            characters += utf16_length(part["text"])
        elif part["kind"] == "event":
            if type(part["tag"]) is not str or part["tag"] not in VOICE_EVENT_TAGS:
                raise ValueError("Unknown voice event tag")
        else:
            require_number(part, "ms")
            if part["ms"] > MAX_VOICE_PAUSE_MS:
                raise ValueError("Voice pauses are limited to 5,000 ms")
    if characters > MAX_VOICE_TEXT_CHARS:
        raise ValueError("Voice synthesis text exceeds the 600 character chunk limit")


def validate_result(command: str, result: Any) -> None:
    if not isinstance(result, dict):
        raise ValueError(f"Invalid worker {command} result: expected an object")
    validate_json_value(result)
    if "timings" in result:
        timings = result["timings"]
        if not isinstance(timings, dict) or any(key not in TIMING_FIELDS for key in timings):
            raise ValueError("Worker timings must be an object containing only known timing fields")
        for key in timings:
            require_number(timings, key)
    for key, options in (("residency", ("resident", "unloaded")),
                         ("warmup", ("not-started", "warming", "complete", "unknown"))):
        if key in result and result[key] not in options:
            raise ValueError(f"Worker field {key} has an unsupported value")
    if "device" in result:
        if result["device"] is not None:
            require_string(result, "device", nonempty=True)
        elif result.get("loaded") is True or result.get("residency") == "resident":
            raise ValueError("Resident worker result requires a nonnull device")
    if command == "capabilities":
        if type(result.get("schemaVersion")) is not int or result["schemaVersion"] != 1:
            raise ValueError("Worker capabilities schemaVersion must be integer 1")
        engine = result.get("engine")
        if engine not in ("speech", "writing"):
            raise ValueError("Worker capabilities engine must be speech or writing")
        backends = ("mlx", "cuda-transformers", "onnx-cpu") if engine == "speech" else ("transformers",)
        if result.get("backend") not in backends:
            raise ValueError("Worker capabilities backend does not match engine")
        if result.get("modelFamily") not in (("r2t2", "canary", "parakeet") if engine == "speech" else ("qwen3.5",)):
            raise ValueError("Worker capabilities modelFamily does not match engine")
        for key in ("timestamps", "vocabularyBiasing"):
            require_boolean(result, key)
        hints = result.get("languageHints")
        if not isinstance(hints, dict):
            raise ValueError("Worker capabilities languageHints must be an object")
        require_boolean(hints, "supported")
        languages = hints.get("languages")
        if not isinstance(languages, list) or any(not bounded_string(language, 64) for language in languages):
            raise ValueError("Worker capabilities languages must be nonempty bounded strings")
    elif command in ("status", "load", "unload", "magicStatus", "magicLoad"):
        require_boolean(result, "loaded")
        for key in ("model", "device"):
            if key in result and result[key] is not None:
                require_string(result, key)
    elif command in ("voiceStatus", "voiceLoad", "voiceUnload"):
        require_boolean(result, "loaded")
        for key in ("model", "device"):
            if key in result and result[key] is not None:
                require_string(result, key)
        if result.get("engine") is not None and result.get("engine") not in VOICE_ENGINES:
            raise ValueError("Worker voice engine is not a known engine")
        residency = result.get("residency")
        if (residency == "resident" and not result["loaded"]) or (residency == "unloaded" and result["loaded"]):
            raise ValueError("Worker voice residency disagrees with loaded state")
        if residency == "unloaded" and result.get("device") is not None:
            raise ValueError("Unloaded voice worker must not report an active device")
    elif command == "voiceSynthesize":
        rate = result.get("sampleRate")
        if type(rate) is not int or not 8000 <= rate <= 48000:
            raise ValueError("Worker voice sampleRate must be an integer between 8000 and 48000")
        require_string(result, "audio")
        require_number(result, "durationMs")
        require_number(result, "processingTimeMs")
        if result.get("engine") not in VOICE_ENGINES:
            raise ValueError("Worker voice engine is not a known engine")
        require_string(result, "device", nonempty=True)
        unsupported = result.get("unsupported")
        if (not isinstance(unsupported, list) or len(unsupported) > MAX_VOICE_UNSUPPORTED
                or any(not bounded_string(item, 64) for item in unsupported)):
            raise ValueError("Worker voice unsupported list must hold at most 32 short names")
    elif command == "transcribe":
        require_string(result, "text")
        require_string(result, "language")
        require_number(result, "duration")
        require_number(result, "processingTime")
        if "inferenceTime" in result:
            require_number(result, "inferenceTime")
    elif command == "magicRewrite":
        require_string(result, "text")
        require_string(result, "model")
        require_number(result, "processingTimeMs")
        require_number(result, "inputCharacters", integer=True)
        require_number(result, "outputCharacters", integer=True)
        require_boolean(result, "includedInferences")
    elif command == "shutdown":
        if result.get("shutdown") is not True:
            raise ValueError("Invalid worker shutdown result: shutdown must be true")
    else:
        raise ValueError(f"Cannot validate unknown worker command: {command}")


def terminal_response(payload: dict[str, Any], command: str | None = None) -> dict[str, Any]:
    """Envelope every terminal response and reject malformed backend success."""
    if not isinstance(payload, dict):
        raise ValueError("Worker response must be an object")
    response = {"protocolVersion": PROTOCOL_VERSION, **payload}
    if type(response["protocolVersion"]) is not int or response["protocolVersion"] != PROTOCOL_VERSION:
        raise ValueError("Worker response protocolVersion must be integer 1")
    if "id" not in response or (response["id"] is not None and not bounded_string(response["id"], MAX_ID_BYTES)):
        raise ValueError("Worker response has an invalid correlation id")
    require_boolean(response, "ok")
    if response["ok"]:
        if response["id"] is None or "result" not in response or "error" in response:
            raise ValueError("Worker success requires a correlation id and result, without error")
        if command is None:
            raise ValueError("Worker success requires its command for result validation")
        validate_result(command, response["result"])
    elif "result" in response or not bounded_string(response.get("error"), MAX_ERROR_BYTES):
        raise ValueError("Worker failure requires a nonempty bounded error, without result")
    return response


_private_stream: TextIO | None = None


def protocol_stream() -> TextIO:
    """The stream reserved for protocol lines (see isolate_protocol_output)."""
    if _private_stream is not None:
        return _private_stream
    return sys.__stdout__ if sys.__stdout__ is not None else sys.stdout


def isolate_protocol_output() -> None:
    """Keep protocol lines on a private copy of fd 1.

    Inference libraries start subprocesses (vLLM) that inherit fd 1 and can
    write to it directly, which would corrupt the line protocol. Point fd 1 at
    stderr for everything else.
    """
    global _private_stream
    try:
        sys.stdout.flush()
        private = os.dup(1)
        os.dup2(2, 1)
    except OSError:
        return
    _private_stream = os.fdopen(private, "w", encoding="utf-8", buffering=1)
