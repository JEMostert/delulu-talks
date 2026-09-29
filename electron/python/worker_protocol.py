"""Versioned worker envelopes and command schemas, without model dependencies."""

from __future__ import annotations

import contextlib
from contextvars import ContextVar
import json
import math
import sys
from typing import Any


PROTOCOL_VERSION = 1
MAX_ID_BYTES = 128
MAX_COMMAND_BYTES = 64
MAX_ERROR_BYTES = 8_000
PROGRESS_PREFIX = "@delulu-progress:"
MAX_PROGRESS_STAGE_BYTES = 64
MAX_PROGRESS_DETAIL_BYTES = 4_000
MAX_PROGRESS_LINE_BYTES = 32_768
_active_operation: ContextVar[tuple[str, str] | None] = ContextVar("worker_operation", default=None)
COMMANDS = frozenset({
    "ping", "status", "load", "unload", "magicStatus", "magicLoad",
    "magicUnload", "magicRewrite", "transcribe", "shutdown",
})
MAGIC_PRESETS = frozenset({"polish", "concise", "structured", "prompt", "bullet-points", "professional-message"})
MAGIC_MODELS = frozenset({"qwen35Small", "qwen35Medium", "qwen35Large"})


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
    stream = sys.__stdout__ if sys.__stdout__ is not None else sys.stdout
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
    if command in ("load", "magicLoad") and "cacheDir" in request:
        require_string(request, "cacheDir")
    if command == "magicLoad" and "model" in request:
        require_string(request, "model")
        if request["model"] not in MAGIC_MODELS:
            raise ValueError(f"Unsupported Magic model: {request['model']}")
    if command == "transcribe":
        require_string(request, "audioPath", nonempty=True)
        if "language" in request:
            require_string(request, "language")
        if "durationMs" in request:
            require_number(request, "durationMs")
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


def validate_result(command: str, result: Any) -> None:
    if not isinstance(result, dict):
        raise ValueError(f"Invalid worker {command} result: expected an object")
    validate_json_value(result)
    if command in ("ping", "status", "load", "unload", "magicStatus", "magicLoad", "magicUnload"):
        require_boolean(result, "loaded")
        for key in ("model", "device"):
            if key in result and result[key] is not None:
                require_string(result, key)
        if command == "ping":
            require_string(result, "python", nonempty=True)
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
