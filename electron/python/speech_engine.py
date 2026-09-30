"""Shared lifecycle and transcription contract for local speech backends.

load starts the engine and exercises inference; unload stops it and releases
the model. Implementations raise actionable exceptions, which the JSON worker
normalizes into {ok: false, error: ...} responses.
"""
from typing import Any, NotRequired, Protocol, TypedDict


class PipelineTimings(TypedDict, total=False):
    captureEndMs: float
    preprocessingMs: float
    speechLoadMs: float
    speechRequestMs: float
    backendPreprocessingMs: float
    inferenceMs: float
    rewriteLoadMs: float
    rewritingMs: float
    clipboardMs: float
    pasteMs: float


class Transcription(TypedDict):
    """Recognition output; timings are not calibrated confidence evidence.

    No supported backend currently supplies a calibrated score or uncertain
    spans. Keep those absent rather than inventing percentages or deriving
    certainty from output length, speed, raw token scores, or model identity.
    """

    text: str
    language: str
    duration: float
    processingTime: float
    inferenceTime: float
    timings: NotRequired[PipelineTimings]


class SpeechEngine(Protocol):
    def load(self, request: dict[str, Any]) -> dict[str, Any]: ...
    def unload(self) -> dict[str, Any]: ...
    def status(self) -> dict[str, Any]: ...
    def transcribe(self, request: dict[str, Any]) -> Transcription: ...
