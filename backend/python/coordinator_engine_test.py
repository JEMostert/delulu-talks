"""Coordinator routing rules that run before (or instead of) the model."""
import re
import unittest

import coordinator_engine as engine

AGENTS = [{"id": "agent_1", "label": "Claude Code"}]
TASKS = [{"id": "task_1", "label": "Ruim de logs op"}]


def matches(pattern, text):
    return bool(re.search(pattern, text, re.IGNORECASE))


class StopRuleTests(unittest.TestCase):
    def test_stop_speaking_in_english_and_dutch(self):
        for text in ("Stop.", "Stop talking.", "Can you stop talking now?", "Be quiet",
                     "Hou op met praten.", "Kun je even stoppen met praten?", "Stil!", "Alsjeblieft, stop."):
            self.assertTrue(matches(engine.STOP_SPEAKING, text), text)

    def test_stop_listening_in_english_and_dutch(self):
        for text in ("Turn off the microphone.", "Stop listening", "Zet de microfoon uit.",
                     "Oké, stop met luisteren.", "Doe de mic uit"):
            self.assertTrue(matches(engine.STOP_LISTENING, text), text)

    def test_work_that_starts_with_stop_is_not_a_stop_command(self):
        for text in ("Stop de deployment.", "Stop met de tests draaien en maak een release.",
                     "Stop the build and fix the tests.", "Kan je de build fixen?"):
            self.assertFalse(matches(engine.STOP_SPEAKING, text), text)
            self.assertFalse(matches(engine.STOP_LISTENING, text), text)

    def test_the_model_cannot_choose_stop_intents(self):
        class Tokenizer:
            def encode(self, text, add_special_tokens=False):
                return [ord(char) for char in text]

        trie = engine.route_token_trie(Tokenizer(), {"tasks": [], "agents": []}, [0], allow_cancel=False)
        routes, stack = [], [(trie, "")]
        while stack:
            node, prefix = stack.pop()
            for token, child in node.items():
                if token == 0:
                    routes.append(prefix)
                else:
                    stack.append((child, prefix + chr(token)))
        self.assertTrue(routes)
        self.assertFalse(any("stop_" in route for route in routes))


class DutchReferenceTests(unittest.TestCase):
    def context(self):
        return {"tasks": TASKS, "agents": AGENTS, "focusedTaskId": "task_1", "activeAgentId": "agent_1"}

    def test_dutch_followup_targets_the_focused_task(self):
        targets, _ = engine.eligible_targets("Eigenlijk, sla de oude logs over.", self.context())
        self.assertEqual([task["id"] for task in targets["tasks"]], ["task_1"])

    def test_new_dutch_work_does_not_inherit_focus(self):
        targets, _ = engine.eligible_targets("Schrijf een README.", self.context())
        self.assertEqual(targets["tasks"], [])

    def test_dutch_cancel_needs_a_named_task_and_no_negation(self):
        _, allowed = engine.eligible_targets("Annuleer ruim de logs op.", self.context())
        self.assertTrue(allowed)
        _, allowed = engine.eligible_targets("Annuleer ruim de logs op niet.", self.context())
        self.assertFalse(allowed)
        _, allowed = engine.eligible_targets("Annuleer het.", self.context())
        self.assertFalse(allowed)


if __name__ == "__main__":
    unittest.main()
