"""Voice helper rules and validation that run without the model."""
import unittest

import coordinator_engine as engine

AGENT = {"id": "agent_1", "label": "Claude Code", "listening": True}
TASK = {"id": "task_1", "label": "Run the unit tests", "agent": "Claude Code", "state": "running"}
CONTEXT = {"agents": [AGENT], "tasks": [TASK]}


def decision(tool, args=None, **extra):
    return {"tool": tool, "args": args or {}, "language": "nl", "elapsedMs": 12.5, **extra}


class LanguageTests(unittest.TestCase):
    def test_dutch_and_english_turns(self):
        for text in ("Draai de unit tests.", "Fix de lag in de app.", "Eigenlijk, sla de trage tests over.", "Hoi, hoor je me?"):
            self.assertEqual(engine.detect_language(text), "nl", text)
        for text in ("Run the unit tests.", "Can you stop talking now?", "Thanks, that's all.", "What can you do?"):
            self.assertEqual(engine.detect_language(text), "en", text)

    def test_unclear_turns_follow_the_conversation(self):
        recent = [{"user": "Hoe staat het ervoor?", "tool": "task_status", "said": "", "interrupted": False}]
        self.assertEqual(engine.detect_language("Oké.", recent), "nl")
        self.assertEqual(engine.detect_language("Oké."), "en")


class ConfirmationTests(unittest.TestCase):
    def test_a_short_yes_confirms(self):
        for text in ("Ja.", "Yes", "ja, doe maar", "Yes please.", "Zeker.", "Go ahead"):
            self.assertTrue(engine.is_affirmative(text), text)

    def test_anything_else_does_not(self):
        for text in ("Nee.", "No, keep it.", "Ja, maar niet nu.", "Wacht even.", "", "Eigenlijk, sla de trage tests over.",
                     "Yes I think we should probably keep going with the other thing"):
            self.assertFalse(engine.is_affirmative(text), text)


class ContextTests(unittest.TestCase):
    def test_every_prompt_example_is_a_valid_context_and_call(self):
        for context, _text, tool, args in engine.EXAMPLES:
            context = engine.validate_context({"recent": [], "tasks": [], **context})
            engine._validate_call({"tool": tool, "args": args}, context, engine.TOOLS)

    def test_rejects_unknown_fields_bad_ids_and_oversized_lists(self):
        bad = [
            {"agents": [AGENT], "extra": 1},
            {"agents": [{**AGENT, "id": "claude"}]},
            {"agents": [AGENT, {**AGENT, "id": "agent_2"}]},
            {"tasks": [{**TASK, "state": "completed"}]},
            {"tasks": [TASK], "pendingCancel": "task_2"},
            {"recent": [{"user": "Hi", "tool": "classify", "said": "", "interrupted": False}]},
            {"tasks": [{**TASK, "id": f"task_{n}"} for n in range(17)]},
        ]
        for context in bad:
            with self.assertRaises(ValueError, msg=context):
                engine.validate_context(context)

    def test_context_block_lists_agents_tasks_memory_and_language(self):
        context = {**CONTEXT, "pendingCancel": "task_1",
                   "recent": [{"user": "Draai de tests.", "tool": "send_to_agent", "said": "Doorgestuurd.", "interrupted": True}]}
        block = engine._context_block(context, "nl")
        for part in ("agent_1 Claude Code (listening)", 'task_1 "Run the unit tests"', "Doorgestuurd.", "(interrupted)",
                     "Waiting for a yes to cancel task_1", "Language: Dutch"):
            self.assertIn(part, block)


class ResultTests(unittest.TestCase):
    def test_decisions_must_stay_inside_their_context(self):
        engine.validate_decision(decision("send_to_agent", {"task": "task_1"}), CONTEXT)
        engine.validate_decision(decision("reply", {"text": "Graag gedaan."}), CONTEXT)
        for bad in (decision("classify"), decision("send_to_agent", {"task": "task_9"}),
                    decision("send_to_agent", {"text": "Run the tests"}), decision("cancel_task"),
                    decision("reply", {"text": "two\nlines"}), decision("reply", {"text": "x" * 301}),
                    {**decision("stop_speaking"), "language": "fr"}, {**decision("stop_speaking"), "elapsedMs": -1}):
            with self.assertRaises(ValueError, msg=bad):
                engine.validate_decision(bad, CONTEXT)

    def test_confirmation_only_for_the_pending_task(self):
        pending = {**CONTEXT, "pendingCancel": "task_1"}
        engine.validate_decision(decision("cancel_task", {"task": "task_1"}, confirmed=True), pending)
        with self.assertRaises(ValueError):
            engine.validate_decision(decision("cancel_task", {"task": "task_1"}, confirmed=True), CONTEXT)
        with self.assertRaises(ValueError):
            engine.validate_decision(decision("send_to_agent", {}, confirmed=True), pending)

    def test_reply_requests_and_results(self):
        request = {"protocolVersion": 1, "id": "r", "command": "coordinatorReply", "text": "Draai de tests.",
                   "context": CONTEXT, "call": {"tool": "send_to_agent", "args": {}}, "result": "Sent to Claude Code."}
        engine.validate_coordinator_request(request)
        for change in ({"call": {"tool": "reply", "args": {"text": "Hoi"}}}, {"result": ""}, {"extra": True}):
            with self.assertRaises(ValueError, msg=change):
                engine.validate_coordinator_request({**request, **change})
        engine.validate_reply({"text": "Doorgestuurd naar Claude Code.", "elapsedMs": 140})
        with self.assertRaises(ValueError):
            engine.validate_reply({"text": "Doorgestuurd", "elapsedMs": 1, "tool": "reply"})

    def test_named_agents(self):
        self.assertTrue(engine._names("Laat Claude Code de lint errors fixen.", "Claude Code"))
        self.assertFalse(engine._names("Laat Claude de lint errors fixen.", "Claude Code"))


if __name__ == "__main__":
    unittest.main()
