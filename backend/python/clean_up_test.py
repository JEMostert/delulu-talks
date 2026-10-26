"""Rule-based parts of dictation clean-up; the model prompt is measured by scripts/rewrite-eval."""
import unittest

from clean_up import polish_accepted, strip_fillers


class StripFillersTests(unittest.TestCase):
    def test_removes_hesitation_sounds_in_english_and_dutch(self):
        self.assertEqual(strip_fillers("So um I was thinking, uh, we could ship"), "So I was thinking, we could ship")
        self.assertEqual(strip_fillers("Eh ja dus ik heb eh gekeken. Uhm, het werkt."), "Ja dus ik heb gekeken. Het werkt.")

    def test_keeps_words_that_contain_or_resemble_fillers(self):
        for text in ("Er is een umbrella bug.", "Hum the tune.", "Uh-oh.", "Make sure e.g. tests run."):
            with self.subTest(text=text):
                self.assertEqual(strip_fillers(text), text)

    def test_leaves_spacing_and_lines_untouched(self):
        self.assertEqual(strip_fillers("a  b\n    indented uh line"), "a  b\n    indented line")

    def test_text_of_only_fillers_is_kept(self):
        self.assertEqual(strip_fillers("uh"), "uh")


class AcceptTests(unittest.TestCase):
    def test_accepts_repunctuation_and_repeated_words(self):
        self.assertTrue(polish_accepted("the the build is ready", "The build is ready."))

    def test_rejects_changed_content(self):
        self.assertFalse(polish_accepted("Do not deploy", "Deploy"))
        self.assertFalse(polish_accepted("Can you fix the login bug?", "Sure, I fixed the login bug for you just now."))


if __name__ == "__main__":
    unittest.main()
