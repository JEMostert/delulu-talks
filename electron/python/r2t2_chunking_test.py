import math
import unittest

from r2t2_speech import SAMPLE_RATE, chunk_bounds


class WindowsChunkingTests(unittest.TestCase):
    def test_cuts_land_in_the_quiet_gap_before_the_boundary(self):
        chunk = 30 * SAMPLE_RATE
        samples = [math.sin(index / 7) for index in range(70 * SAMPLE_RATE)]
        gap = range(int(29.2 * SAMPLE_RATE), int(29.5 * SAMPLE_RATE))
        for index in gap:
            samples[index] = 0.0
        bounds = chunk_bounds(samples, chunk)
        self.assertEqual(bounds[0][0], 0)
        self.assertIn(bounds[0][1], gap)
        self.assertEqual(bounds[-1][1], len(samples))
        for (_, end), (start, _) in zip(bounds, bounds[1:]):
            self.assertEqual(end, start)
        self.assertTrue(all(end - start <= chunk for start, end in bounds))

    def test_short_audio_is_one_chunk(self):
        self.assertEqual(chunk_bounds([0.1] * 100, 30 * SAMPLE_RATE), [(0, 100)])


if __name__ == "__main__":
    unittest.main()
