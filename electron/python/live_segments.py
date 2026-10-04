"""Phrase-level live typing for speech models without native streaming.

Audio arrives in small pieces while the user talks. A phrase ends at a pause,
so every cut falls between words; each phrase is transcribed on its own and
its text is final the moment it is returned.
"""
from __future__ import annotations

from typing import Callable
from stream_buffer import StreamBuffer

SAMPLE_RATE = 16000
FRAME = SAMPLE_RATE // 50  # 20 ms


class PauseStreamer:
    def __init__(
        self,
        transcribe: Callable[[object], str],
        silence_ms: int = 450,
        min_speech_ms: int = 300,
        max_phrase_s: float = 12.0,
    ) -> None:
        import numpy as np
        self.np = np
        self.transcribe = transcribe
        self.audio = StreamBuffer()
        self.start = 0  # first sample of the current phrase
        self.scanned = 0  # samples already classified
        self.speech_frames = 0
        self.silent_frames = 0
        self.floor = 0.004
        self.silence_frames_needed = silence_ms // 20
        self.speech_frames_needed = min_speech_ms // 20
        self.max_phrase = int(max_phrase_s * SAMPLE_RATE)
        self.emitted = False

    def _rms(self, frame) -> float:
        return float(self.np.sqrt(self.np.mean(frame * frame))) if len(frame) else 0.0

    def _emit(self, end: int) -> str:
        phrase = self.audio.slice(self.start, end)
        self.start = end
        self.speech_frames = 0
        self.silent_frames = 0
        text = self.transcribe(phrase).strip() if len(phrase) else ""
        if not text:
            return ""
        piece = (" " if self.emitted else "") + text
        self.emitted = True
        return piece

    def push(self, samples) -> str:
        self.audio.append(samples)
        out = ""
        while self.scanned + FRAME <= self.audio.end:
            frame = self.audio.slice(self.scanned, self.scanned + FRAME)
            self.scanned += FRAME
            level = self._rms(frame)
            # Track the room's noise floor slowly; speech is well above it.
            if level < self.floor * 1.5:
                self.floor = 0.95 * self.floor + 0.05 * max(level, 1e-4)
            if level > max(self.floor * 3.0, 0.008):
                self.speech_frames += 1
                self.silent_frames = 0
            else:
                self.silent_frames += 1
            if (
                self.speech_frames >= self.speech_frames_needed
                and self.silent_frames >= self.silence_frames_needed
            ):
                # Cut in the middle of the pause, between two words.
                out += self._emit(self.scanned - (self.silent_frames * FRAME) // 2)
            elif self.scanned - self.start >= self.max_phrase:
                out += self._emit(self._quietest(self.scanned - SAMPLE_RATE, self.scanned))
            elif self.speech_frames == 0 and self.silent_frames * FRAME > SAMPLE_RATE:
                # Drop leading silence so it is never sent to the model.
                self.start = self.scanned - FRAME * 10
                self.silent_frames = 10
        self.audio.discard_before(self.start)
        return out

    def _quietest(self, begin: int, end: int) -> int:
        best, best_level = end, None
        for position in range(max(begin, self.start + FRAME), end - FRAME + 1, FRAME):
            level = self._rms(self.audio.slice(position, position + FRAME))
            if best_level is None or level < best_level:
                best, best_level = position + FRAME // 2, level
        return best

    def finish(self) -> str:
        if self.speech_frames >= 3 or (self.emitted is False and self.speech_frames):
            return self._emit(self.audio.end)
        return ""
