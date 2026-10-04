import math
import unittest

try:
    import numpy as np
except ImportError:  # CI runners without NumPy skip the audio tests.
    np = None

from live_segments import SAMPLE_RATE, PauseStreamer


def tone(seconds):
    t = np.arange(int(seconds * SAMPLE_RATE)) / SAMPLE_RATE
    return (0.2 * np.sin(2 * math.pi * 220 * t)).astype(np.float32)


def quiet(seconds):
    return np.zeros(int(seconds * SAMPLE_RATE), dtype=np.float32)


@unittest.skipIf(np is None, "NumPy is not installed")
class PauseStreamerTests(unittest.TestCase):
    def test_phrases_end_at_pauses_and_join_with_spaces(self):
        heard = []
        streamer = PauseStreamer(lambda audio: heard.append(len(audio)) or f"phrase{len(heard)}")
        audio = np.concatenate([quiet(0.3), tone(1.0), quiet(0.8), tone(0.7), quiet(0.2)])
        out = ""
        for i in range(0, len(audio), 4000):
            out += streamer.push(audio[i:i + 4000])
        out += streamer.finish()
        self.assertEqual(out, "phrase1 phrase2")
        self.assertEqual(len(heard), 2)

    def test_silence_alone_produces_nothing(self):
        streamer = PauseStreamer(lambda audio: "never")
        self.assertEqual(streamer.push(quiet(3)), "")
        self.assertEqual(streamer.finish(), "")


if __name__ == "__main__":
    unittest.main()
