"""Protect the desktop/worker trust boundary without starting ML runtimes."""
import io
import json
import unittest
from unittest.mock import patch

import worker_protocol as protocol


def request(command, **fields):
    return {"protocolVersion": 1, "id": "operation", "command": command, **fields}


class WorkerProtocolTests(unittest.TestCase):
    def test_untrusted_requests_require_correlatable_finite_versioned_data(self):
        valid = request("transcribe", audioPath="recording.wav", durationMs=12)
        self.assertIs(protocol.validate_request(valid), valid)
        invalid = [None, [], {**valid, "protocolVersion": True},
                   {**valid, "id": "😀" * 33}, {**valid, "id": "\ud800"},
                   {**valid, "command": "execute"}, {**valid, "command": "streamStart"}, {**valid, "audioPath": ""},
                   {**valid, "durationMs": float("nan")}, {**valid, "durationMs": True},
                   {**valid, "timestamps": True}, {**valid, "streaming": True},
                   {**valid, "extra": float("inf")}]
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValueError):
                protocol.validate_request(value)
        self.assertEqual(protocol.correlation_id(request("ping", id="😀" * 32)), "😀" * 32)
        self.assertIsNone(protocol.correlation_id(request("ping", id="😀" * 33)))

    def test_rewrite_contract_enforces_choices_and_javascript_character_limits(self):
        protocol.validate_request(request("magicRewrite", text="Draft", instructions="😀" * 2000))
        for fields in ({"instructions": "😀" * 2001}, {"preset": "invent-facts"},
                       {"allowInferences": "false"}, {"text": 12}):
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                protocol.validate_request(request("magicRewrite", **{"text": "Draft", **fields}))
        with self.assertRaises(ValueError):
            protocol.validate_request(request("magicLoad", model="remote"))

    def test_terminal_envelopes_never_publish_malformed_backend_success(self):
        result = {"text": "Words", "language": "und", "duration": 1, "processingTime": 0.2}
        success = {"id": "operation", "ok": True, "result": result}
        self.assertEqual(protocol.terminal_response(success, "transcribe")["protocolVersion"], 1)
        invalid = [({**success, "id": None}, "transcribe"),
                   ({**success, "error": "also failed"}, "transcribe"),
                   ({**success, "result": {**result, "processingTime": -1}}, "transcribe"),
                   ({**success, "result": {**result, "timings": {"unknown": 1}}}, "transcribe"),
                   ({**success, "result": {**result, "residency": "resident", "device": None}}, "transcribe"),
                   ({"id": "operation", "ok": False, "error": "", "result": result}, None),
                   ({"id": "operation", "ok": 1, "result": result}, "transcribe")]
        for payload, command in invalid:
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                protocol.terminal_response(payload, command)
        self.assertFalse(protocol.terminal_response({"id": None, "ok": False, "error": "Invalid request"})["ok"])

    def test_progress_callbacks_keep_request_ownership_after_nested_operations(self):
        output = io.StringIO()
        with patch.object(protocol.sys, "__stdout__", output):
            with protocol.operation_scope("download", "load"):
                callback = protocol.capture_progress_emitter()
                with protocol.operation_scope("rewrite", "magicLoad"):
                    protocol.emit_progress("Other model", stage="load")
            callback("Original download", stage="download", download_bytes={"completed": 2, "total": 3, "kind": "transfer"})
        events = [json.loads(line.removeprefix(protocol.PROGRESS_PREFIX)) for line in output.getvalue().splitlines()]
        self.assertEqual([(event["id"], event["command"]) for event in events],
                         [("rewrite", "magicLoad"), ("download", "load")])
        with self.assertRaises(ValueError):
            protocol.validate_progress({**events[-1], "downloadBytes": {"completed": 4, "total": 3, "kind": "transfer"}})


if __name__ == "__main__":
    unittest.main()
