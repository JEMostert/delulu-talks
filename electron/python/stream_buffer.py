"""Growable mono PCM with absolute sample offsets and reusable storage.

Consumed samples are released without copying on every chunk. Appending only
compacts or grows when the free tail is exhausted; callers provide locking
when producers and consumers run on different threads.
"""
from __future__ import annotations


class StreamBuffer:
    def __init__(self, capacity: int = 32000) -> None:
        import numpy as np
        self.np = np
        self.data = np.empty(capacity, dtype=np.float32)
        self.offset = 0
        self.begin = 0
        self.size = 0

    @property
    def end(self) -> int:
        return self.offset + self.size

    def append(self, samples) -> None:
        samples = self.np.asarray(samples, dtype=self.np.float32)
        needed = self.size + len(samples)
        if self.begin + needed > len(self.data):
            if needed > len(self.data):
                replacement = self.np.empty(max(needed, len(self.data) * 2), dtype=self.np.float32)
                replacement[:self.size] = self.data[self.begin:self.begin + self.size]
                self.data = replacement
            else:
                self.data[:self.size] = self.data[self.begin:self.begin + self.size].copy()
            self.begin = 0
        self.data[self.begin + self.size:self.begin + needed] = samples
        self.size = needed

    def slice(self, start: int, end: int):
        if not self.offset <= start <= end <= self.end:
            raise ValueError("Live audio window is outside the retained buffer")
        begin = self.begin + start - self.offset
        return self.data[begin:begin + end - start]

    def discard_before(self, position: int) -> None:
        position = min(max(position, self.offset), self.end)
        count = position - self.offset
        self.begin += count
        self.size -= count
        self.offset = position
