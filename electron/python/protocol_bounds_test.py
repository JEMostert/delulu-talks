"""Bounded real worker protocol with fixture dispatch; no models or downloads."""
import io
import json
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import transcription_engine as engine


def request_line(value):
    return json.dumps(value, ensure_ascii=False).encode("utf-8")


class ProtocolBoundsTest(unittest.TestCase):
    def run_loop(self, raw, dispatch, request_limit=4096, response_limit=4096):
        calls = []

        class FixtureWorker:
            def dispatch(self, request):
                calls.append(request)
                return dispatch(request)

        source = io.TextIOWrapper(io.BytesIO(raw), encoding="utf-8")
        output, diagnostic = io.StringIO(), io.StringIO()
        try:
            with patch.object(engine, "Worker", FixtureWorker), \
                    patch.object(engine, "MAX_REQUEST_BYTES", request_limit), \
                    patch.object(engine, "MAX_RESPONSE_BYTES", response_limit), \
                    patch.object(engine.sys, "stdin", source), \
                    patch.object(engine.sys, "stdout", output), \
                    patch.object(engine.sys, "stderr", diagnostic):
                code = engine.main()
        finally:
            source.close()
        lines = output.getvalue().splitlines()
        self.assertTrue(all(line.startswith(engine.PROTOCOL_PREFIX) for line in lines))
        responses = [json.loads(line[len(engine.PROTOCOL_PREFIX):]) for line in lines]
        return code, calls, responses, output.getvalue(), diagnostic.getvalue()

    def test_exact_utf8_request_boundary_accepts_lf_crlf_and_eof(self):
        value = {"protocolVersion": 1, "id": "unicode", "command": "status", "text": "👋 中文 é"}
        raw = request_line(value)
        self.assertGreater(len(raw), len(raw.decode("utf-8")))
        for ending in [b"\n", b"\r\n", b""]:
            with self.subTest(ending=ending):
                code, calls, responses, _, _ = self.run_loop(
                    raw + ending, lambda request: {"loaded": False, "text": request["text"]}, len(raw))
                self.assertEqual(code, 0)
                self.assertEqual(calls, [value])
                self.assertEqual(responses, [{"protocolVersion": 1, "id": "unicode", "ok": True, "result": {"loaded": False, "text": value["text"]}}])

    def test_oversized_input_exits_without_dispatch_or_partial_response(self):
        value = {"protocolVersion": 1, "id": "oversized", "command": "status", "text": "👋" * 32}
        raw = request_line(value)
        for ending in [b"\n", b"", b"\r\n"]:
            with self.subTest(ending=ending):
                code, calls, responses, output, diagnostic = self.run_loop(
                    raw + ending, lambda _: "must not execute", len(raw) - 1)
                self.assertEqual(code, 2)
                self.assertEqual(calls, [])
                self.assertEqual(responses, [])
                self.assertEqual(output, "")
                self.assertIn("Shorten the input", diagnostic)

    def test_extra_carriage_returns_cannot_hide_oversized_or_partial_input(self):
        value = {"protocolVersion": 1, "id": "boundary", "command": "status"}
        raw = request_line(value)
        for ending in [b"\r\r\n", b"\r" * 40 + b"\n", b"\r\r" + request_line(value)]:
            with self.subTest(ending=ending):
                code, calls, responses, _, _ = self.run_loop(
                    raw + ending, lambda _: "must not execute", len(raw))
                self.assertEqual(code, 2)
                self.assertEqual(calls, [])
                self.assertEqual(responses, [])

    def test_exact_response_byte_boundary_is_valid_and_overflow_writes_nothing(self):
        payload = {"protocolVersion": 1, "id": "unicode", "ok": True, "result": {"loaded": False, "text": "👋中文"}}
        expected = engine.PROTOCOL_PREFIX + json.dumps(payload, ensure_ascii=False)
        for difference in [0, -1]:
            with self.subTest(difference=difference):
                output = io.StringIO()
                with patch.object(engine, "MAX_RESPONSE_BYTES", len(expected.encode("utf-8")) + difference), \
                        patch.object(engine.sys, "stdout", output):
                    if difference:
                        with self.assertRaisesRegex(ValueError, "response exceeds"):
                            engine.emit(payload, "status")
                        self.assertEqual(output.getvalue(), "")
                    else:
                        engine.emit(payload, "status")
                        self.assertEqual(output.getvalue(), expected + "\n")

    def test_response_overflow_rejects_one_request_and_allows_intentional_retry(self):
        values = [{"protocolVersion": 1, "id": "large", "command": "status"}, {"protocolVersion": 1, "id": "retry", "command": "status"}]
        raw = b"\n".join(map(request_line, values)) + b"\n"
        code, calls, responses, output, _ = self.run_loop(
            raw, lambda request: {"loaded": False, "text": "👋" * 2048 if request["id"] == "large" else "still ready"},
            response_limit=512)
        self.assertEqual(code, 0)
        self.assertEqual(calls, values)
        self.assertFalse(responses[0]["ok"])
        self.assertIn("Shorten the input", responses[0]["error"])
        self.assertEqual(responses[1], {"protocolVersion": 1, "id": "retry", "ok": True, "result": {"loaded": False, "text": "still ready"}})
        self.assertTrue(all(len(line.encode("utf-8")) <= 512 for line in output.splitlines()))

    def test_huge_exception_text_is_byte_bounded_and_next_request_survives(self):
        values = [{"protocolVersion": 1, "id": "failure", "command": "status"}, {"protocolVersion": 1, "id": "retry", "command": "status"}]

        def dispatch(request):
            if request["id"] == "failure":
                raise RuntimeError("👋" * 20_000)
            return {"loaded": False, "text": "available for retry"}

        code, _, responses, _, diagnostic = self.run_loop(
            b"\n".join(map(request_line, values)), dispatch, response_limit=16_384)
        self.assertEqual(code, 0)
        error = responses[0]["error"]
        self.assertLessEqual(len(error.encode("utf-8")), engine.MAX_ERROR_BYTES)
        self.assertNotIn("�", error)
        self.assertLess(len(diagnostic.encode("utf-8")), engine.MAX_ERROR_BYTES + 2048)
        self.assertEqual(responses[1]["result"]["text"], "available for retry")

    def test_blank_lines_and_request_local_errors_preserve_order(self):
        values = [{"protocolVersion": 1, "id": "bad", "command": "status"}, {"protocolVersion": 1, "id": "good", "command": "shutdown"}]

        def dispatch(request):
            if request["id"] == "bad":
                raise ValueError("Fixture rejection")
            return {"shutdown": True}

        code, calls, responses, _, _ = self.run_loop(
            b"\n  \r\n" + b"\n\n".join(map(request_line, values)) + b"\n", dispatch)
        self.assertEqual(code, 0)
        self.assertEqual(calls, values)
        self.assertEqual([response["id"] for response in responses], ["bad", "good"])
        self.assertFalse(responses[0]["ok"])
        self.assertTrue(responses[1]["ok"])

    def test_real_process_rejects_unterminated_oversized_input_without_backend_work(self):
        result = subprocess.run(
            [sys.executable, "-u", str(Path(engine.__file__))],
            input=b"x" * (engine.MAX_REQUEST_BYTES + 3),
            capture_output=True, timeout=5, check=False)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertEqual(result.stdout, b"")
        self.assertIn(b"Shorten the input", result.stderr)


if __name__ == "__main__":
    unittest.main()
