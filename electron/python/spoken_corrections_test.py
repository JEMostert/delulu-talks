"""Keep original user content safe when a model proposes spoken deletions."""
import json
import unittest

from spoken_corrections import SpokenCorrectionError, apply_spoken_corrections


def proposal(remove, cue):
    return json.dumps([{"remove": remove, "cue": cue}])


class SpokenCorrectionsTests(unittest.TestCase):
    def test_precise_corrections_preserve_unrelated_indentation_and_numbers(self):
        source = "Schedule Tuesday, sorry, Wednesday at 3.\n\n```python\n    return  40\n```"
        corrected = apply_spoken_corrections(source, proposal("Tuesday, ", "sorry, "))
        self.assertEqual(corrected, "Schedule Wednesday at 3.\n\n```python\n    return  40\n```")
        self.assertEqual(apply_spoken_corrections("  Draft\n\tunchanged  ", "[]"), "  Draft\n\tunchanged  ")

    def test_multiple_disjoint_deletions_use_original_indices(self):
        source = "Tuesday, sorry, Wednesday. Send 40, no, 50 dollars."
        edits = [{"remove": "Tuesday, ", "cue": "sorry, "}, {"remove": "40, ", "cue": "no, "}]
        self.assertEqual(apply_spoken_corrections(source, "```json\n" + json.dumps(edits) + "\n```"),
                         "Wednesday. Send 50 dollars.")

    def test_model_cannot_delete_ambiguous_partial_reordered_or_overlapping_words(self):
        invalid = [("Tuesday Tuesday, sorry, Wednesday", proposal("Tuesday", "sorry, ")),
                   ("Tuesday, sorry, Wednesday", proposal("Tues", "sorry, ")),
                   ("sorry, Tuesday", proposal("Tuesday", "sorry, ")),
                   ("Tuesday, sorry, Wednesday", json.dumps([{"remove": "Tuesday, ", "cue": "sorry, "}] * 2)),
                   ("Tuesday, sorry, Wednesday", "Please replace it with Friday."),
                   ("Tuesday, sorry, Wednesday", '[{"remove":"Tuesday, ","cue":"sorry, ","insert":"Friday"}]')]
        for source, edits in invalid:
            with self.subTest(edits=edits), self.assertRaises(SpokenCorrectionError):
                apply_spoken_corrections(source, edits)

    def test_reported_speech_and_quoted_cues_remain_immutable(self):
        source = 'She said, “Tuesday, sorry, Wednesday.” Keep her quote.'
        self.assertEqual(apply_spoken_corrections(source, proposal("Tuesday, ", "sorry, ")), source)
        source = 'Tuesday. She said "never mind".'
        self.assertEqual(apply_spoken_corrections(source, proposal("Tuesday.", "never mind")), source)
        self.assertEqual(apply_spoken_corrections("That’s Tuesday, sorry, Wednesday.", proposal("That's Tuesday, ", "sorry, ")),
                         "Wednesday.")

    def test_complete_cancellation_stops_delivery_with_text_free_error(self):
        source = "Make a logo. Actually, cancel that entire request."
        with self.assertRaises(SpokenCorrectionError) as caught:
            apply_spoken_corrections(source, proposal("Make a logo.", "Actually, cancel that entire request."))
        self.assertIn("Nothing remains", str(caught.exception))
        self.assertNotIn(source, str(caught.exception))


if __name__ == "__main__":
    unittest.main()
