"""Voice planning, protocol and role isolation without loading audio libraries."""
import os
import re
import unittest
from pathlib import Path
from unittest.mock import patch

import transcription_engine as engine
import voice_engine as voice
import worker_protocol as protocol

SHARED = Path(__file__).resolve().parents[2] / "src" / "voice.ts"


def text(value):
    return {"kind": "text", "text": value}


def event(tag):
    return {"kind": "event", "tag": tag}


def pause(ms):
    return {"kind": "pause", "ms": ms}


def synthesis(**fields):
    return {"protocolVersion": 1, "id": "speak", "command": "voiceSynthesize", "engine": "kokoro",
            "voice": "af_heart", "speed": 1, "styles": [], "parts": [text("Hello.")], **fields}


class VoicePlanTests(unittest.TestCase):
    def test_kokoro_skips_sounds_as_short_pauses_and_reports_them(self):
        plan = voice.plan_synthesis("kokoro", [text("Okay, my fault"), event("laugh"), text(". Fixed it.")], [], 1.0)
        self.assertEqual([(run.kind, run.text, run.ms) for run in plan.runs],
                         [("speech", "Okay, my fault", 0), ("silence", "", voice.SKIPPED_EVENT_MS),
                          ("speech", "Fixed it.", 0)])
        self.assertEqual(plan.unsupported, ["laugh"])
        only_sound = voice.plan_synthesis("kokoro", [event("chuckle")], [], 1.0)
        self.assertEqual([(run.kind, run.ms) for run in only_sound.runs], [("silence", voice.SKIPPED_EVENT_MS)])
        self.assertEqual(only_sound.unsupported, ["chuckle"])

    def test_trimmed_parts_join_with_spaces_except_before_punctuation(self):
        plan = voice.plan_synthesis("chatterbox-turbo",
                                    [text("Okay, that one was my fault"), event("laugh"), text(". Fixed it"),
                                     text("and merged"), event("sigh"), text(", finally"), text("…"),
                                     text("(really)"), event("gasp")], [], 1.0)
        self.assertEqual(plan.runs[0].text,
                         "Okay, that one was my fault [laugh]. Fixed it and merged [sigh], finally… (really) [gasp]")
        self.assertEqual(voice.join_pieces(["Hello", "world", "!", "  spaced   out  "]), "Hello world! spaced out")

    def test_a_chunk_may_end_with_a_pause(self):
        plan = voice.plan_synthesis("kokoro", [text("Wait for it."), pause(600)], [], 1.0)
        self.assertEqual([(run.kind, run.ms) for run in plan.runs], [("speech", 0), ("silence", 600)])

    def test_kokoro_approximates_whisper_and_prosody_and_reports_emotions(self):
        plan = voice.plan_synthesis("kokoro", [text("Between us.")], ["whisper", "slow", "happy"], 1.2)
        self.assertAlmostEqual(plan.rate, 0.95 * 0.85 * 1.2)
        self.assertAlmostEqual(plan.gain_db, -8.0)
        self.assertEqual(plan.unsupported, ["happy"])
        self.assertEqual(plan.runs[0].text, "Between us.")

    def test_chatterbox_performs_sounds_inline_and_prefixes_styles(self):
        plan = voice.plan_synthesis("chatterbox-turbo",
                                    [text("Okay"), event("clear-throat"), text("that was"), event("laugh"),
                                     text("my fault.")], ["whisper", "sarcastic", "loud"], 1.0)
        self.assertEqual([run.text for run in plan.runs],
                         ["[whispering] [sarcastic] Okay [clear throat] that was [laugh] my fault."])
        self.assertEqual(plan.unsupported, [])
        self.assertAlmostEqual(plan.gain_db, voice.CHATTERBOX_WHISPER_GAIN + 4.0)

    def test_pauses_split_runs_merge_and_skip_empty_speech(self):
        plan = voice.plan_synthesis("chatterbox-turbo",
                                    [text("One."), pause(400), text("  "), pause(800), text("Two.")], [], 1.0)
        self.assertEqual([(run.kind, run.text, run.ms) for run in plan.runs],
                         [("speech", "One.", 0), ("silence", "", 1200), ("speech", "Two.", 0)])
        only_sound = voice.plan_synthesis("chatterbox-turbo", [event("sigh")], [], 1.0)
        self.assertEqual([run.text for run in only_sound.runs], ["[sigh]"])
        self.assertEqual(voice.plan_synthesis("kokoro", [event("sigh")], [], 1.0).runs[0].kind, "silence")

    def test_literal_brackets_in_text_cannot_trigger_engine_tokens(self):
        plan = voice.plan_synthesis("chatterbox-turbo", [text("See [laugh] in item [1].")], [], 1.0)
        self.assertEqual(plan.runs[0].text, "See (laugh) in item (1).")

    def test_long_chatterbox_runs_split_at_sentence_ends_within_limit(self):
        sentence = "This sentence is about forty characters. "
        plan = voice.plan_synthesis("chatterbox-turbo", [text(sentence * 14)], ["happy"], 1.0)
        self.assertGreater(len(plan.runs), 1)
        for run in plan.runs:
            self.assertTrue(run.text.startswith("[happy] "))
            self.assertLessEqual(len(run.text.removeprefix("[happy] ")), voice.CHATTERBOX_RUN_CHARACTERS)
            self.assertTrue(run.text.endswith("."))
        unbroken = voice.split_sentences("word " * 120, 50)
        self.assertTrue(all(len(piece) <= 50 for piece in unbroken))
        self.assertEqual(" ".join(unbroken), ("word " * 120).strip())

    def test_rate_is_bounded_and_gain_math_is_decibels(self):
        self.assertEqual(voice.plan_synthesis("kokoro", [text("Hi.")], ["fast"], 4.0).rate, 4.0)
        self.assertAlmostEqual(voice.db_to_gain(6.0), 1.9953, places=3)
        self.assertAlmostEqual(voice.db_to_gain(-20.0), 0.1)

    def test_engine_requires_a_loaded_matching_adapter(self):
        engine_state = voice.VoiceEngine()
        self.assertEqual(engine_state.status(), {"loaded": False, "model": None, "device": None,
                                                 "residency": "unloaded", "warmup": "not-started", "engine": None})
        protocol.validate_result("voiceStatus", engine_state.status())
        with self.assertRaisesRegex(voice.VoiceInputError, "not loaded"):
            engine_state.synthesize(synthesis())

    def test_failed_load_discards_the_adapter(self):
        engine_state = voice.VoiceEngine()
        with patch.object(voice.KokoroVoice, "load", side_effect=RuntimeError("download failed")):
            with self.assertRaises(RuntimeError):
                engine_state.load({"engine": "kokoro"})
        self.assertIsNone(engine_state.adapter)

    def test_downloads_verify_local_snapshots_before_going_online(self):
        import verified_snapshot

        with patch.object(verified_snapshot, "verified_snapshot",
                          side_effect=[RuntimeError("no manifest"), "/snapshot"]) as snapshot, \
                patch.dict(os.environ, {"HF_HUB_OFFLINE": ""}):
            self.assertEqual(voice.download("kokoro", {"cacheDir": "/models"}), "/snapshot")
        self.assertEqual([call.kwargs["local_files_only"] for call in snapshot.call_args_list], [True, False])
        self.assertEqual(snapshot.call_args.kwargs["cache_dir"], str(Path("/models") / "hub"))
        with patch.object(verified_snapshot, "verified_snapshot", side_effect=RuntimeError("missing")), \
                patch.dict(os.environ, {"HF_HUB_OFFLINE": "1"}), self.assertRaises(RuntimeError):
            voice.download("chatterbox-turbo", {})

    def test_vocabulary_matches_the_shared_typescript_contract(self):
        source = SHARED.read_text(encoding="utf-8")

        def names(constant):
            block = re.search(rf"{constant}[^=]*=\s*\[(.*?)\]", source, re.S)
            self.assertIsNotNone(block, constant)
            return re.findall(r'"([a-z-]+)"', block.group(1))

        self.assertEqual(tuple(names("VOICE_EVENT_TAGS")), voice.EVENT_TAGS)
        self.assertEqual(tuple(names("VOICE_EMOTION_STYLES")), voice.EMOTION_STYLES)
        self.assertEqual(tuple(names("VOICE_PROSODY_STYLES")), voice.PROSODY_STYLES)
        self.assertEqual(set(voice.EVENT_TAGS), protocol.VOICE_EVENT_TAGS)
        self.assertEqual(set(voice.EMOTION_STYLES + voice.PROSODY_STYLES), protocol.VOICE_STYLES)
        self.assertEqual(set(voice.ENGINES), protocol.VOICE_ENGINES)
        for engine_id, checkpoint in voice.CHECKPOINTS.items():
            self.assertIn(checkpoint["revision"], source, engine_id)
        kokoro = re.search(r"KOKORO_VOICES[^=]*=\s*\((.*?)\)\.map", source, re.S).group(1)
        for voice_id in re.findall(r'\["([a-z]{2}_[a-z]+)"', kokoro):
            self.assertIn(voice_id, voice.KOKORO_SPEAKERS)

    @unittest.skipUnless(__import__("importlib").util.find_spec("numpy"), "numpy unavailable")
    def test_audio_finishing_levels_limits_peaks_and_encodes_pcm16(self):
        import base64
        import numpy as np

        tone = (0.9 * np.sin(np.linspace(0, 400 * np.pi, voice.SAMPLE_RATE))).astype(np.float32)
        padded = np.concatenate([np.zeros(voice.SAMPLE_RATE), tone, np.zeros(voice.SAMPLE_RATE)]).astype(np.float32)
        trimmed = voice.trim(padded)
        edge = int(voice.SAMPLE_RATE * voice.EDGE_MS / 1000)
        self.assertLessEqual(trimmed.size, tone.size + 2 * edge + 1)
        finished = voice.finish(trimmed, 12.0)
        self.assertLessEqual(float(np.max(np.abs(finished))), voice.db_to_gain(voice.PEAK_LIMIT_DBFS) + 1e-6)
        pcm = np.frombuffer(base64.b64decode(voice.encode_pcm16(np.array([1.0, -1.0, 0.0, 2.0]))), "<i2")
        self.assertEqual(pcm.tolist(), [32767, -32767, 0, 32767])


class VoiceRoleTests(unittest.TestCase):
    def test_voice_input_errors_reach_the_desktop_verbatim(self):
        message = "The voice clip must be at least 5 seconds long. Choose a longer clip."
        self.assertEqual(engine.bounded_error(voice.VoiceInputError(message)), message)

    def test_voice_role_is_isolated_from_speech_and_writing(self):
        worker = engine.Worker()
        with patch.dict(os.environ, {"DELULU_RUNTIME_KIND": "voice"}):
            for forbidden in ("load", "transcribe", "magicLoad", "capabilities", "status"):
                with self.subTest(command=forbidden), self.assertRaisesRegex(ValueError, "not allowed"):
                    worker.dispatch({"command": forbidden, "engine": "speech"})
            self.assertFalse(worker.dispatch({"command": "voiceStatus"})["loaded"])
        for role in ("speech", "magic"):
            with patch.dict(os.environ, {"DELULU_RUNTIME_KIND": role}):
                for forbidden in ("voiceStatus", "voiceLoad", "voiceSynthesize", "voiceUnload"):
                    with self.subTest(role=role, command=forbidden), self.assertRaisesRegex(ValueError, "not allowed"):
                        worker.dispatch({"command": forbidden, "engine": "kokoro"})

    def test_shutdown_unloads_only_the_roles_own_models(self):
        for role, expected in (("voice", {"voice"}), ("speech", {"speech"}), ("magic", {"magic"}),
                               ("", {"speech", "magic", "voice"})):
            worker = engine.Worker()
            worker.voice = voice.VoiceEngine()
            calls = set()
            with patch.dict(os.environ, {"DELULU_RUNTIME_KIND": role}), \
                    patch.object(worker, "unload", side_effect=lambda: calls.add("speech")), \
                    patch.object(worker, "unload_magic", side_effect=lambda: calls.add("magic")), \
                    patch.object(worker, "unload_voice", side_effect=lambda: calls.add("voice")):
                self.assertEqual(worker.dispatch({"command": "shutdown"}), {"shutdown": True})
            self.assertEqual(calls, expected, role)

    def test_failed_synthesis_clears_transient_memory_and_keeps_the_model(self):
        worker = engine.Worker()
        state = worker.voice_engine()
        with patch.object(state, "synthesize", side_effect=RuntimeError("cuda failed")), \
                patch.object(worker, "clear_allocator") as cleanup:
            with self.assertRaises(RuntimeError):
                worker.synthesize_voice(synthesis())
            cleanup.assert_called_once_with()
        self.assertIs(worker.voice, state)


if __name__ == "__main__":
    unittest.main()
