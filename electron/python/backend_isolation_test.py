"""Import isolation and real JSON-lines workflows; no model downloads or inference."""
import builtins
import contextlib
import json
import subprocess
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import transcription_engine as engine


PLATFORMS = [
    ("darwin", "arm64", "metal_speech", "MetalSpeech",
     "mlx-community/Confucius4-R2T2-bf16", "mlx"),
    ("win32", "AMD64", "windows_speech", "WindowsSpeech",
     "netease-youdao/Confucius4-R2T2", "cuda"),
]
OPTIONAL_MODULES = {
    "metal_speech", "windows_speech", "r2t2", "vllm", "mlx",
    "mlx_audio", "torch", "transformers", "numpy", "soundfile",
}


@contextlib.contextmanager
def forbid_imports(names):
    original = builtins.__import__
    attempts = []

    def guarded(name, *args, **kwargs):
        if name.split(".")[0] in names:
            attempts.append(name)
            raise ModuleNotFoundError(f"Fixture missing optional module: {name}")
        return original(name, *args, **kwargs)

    with patch("builtins.__import__", guarded):
        yield attempts


# Run the real worker loop in a separate process with simulated platform identity.
# Only the dependencies needed by the synthetic writing workflow are provided.
PROTOCOL_BOOTSTRAP = r'''
import builtins,contextlib,importlib.util,platform,sys,types
from pathlib import Path
sys.path.insert(0,str(Path(sys.argv[1]).parent))
spec=importlib.util.spec_from_file_location('engine',sys.argv[1])
engine=importlib.util.module_from_spec(spec);spec.loader.exec_module(engine)
sys.platform=sys.argv[2];platform.machine=lambda:sys.argv[3]
blocked=set(sys.argv[4].split(','))
original=builtins.__import__
def guarded(name,*args,**kwargs):
    if name.split('.')[0] in blocked:
        raise ModuleNotFoundError('Fixture missing optional module: '+name)
    return original(name,*args,**kwargs)
builtins.__import__=guarded
torch=types.SimpleNamespace(
    cuda=types.SimpleNamespace(is_available=lambda:sys.argv[5]=='cuda',empty_cache=lambda:None),
    backends=types.SimpleNamespace(mps=types.SimpleNamespace(is_available=lambda:False)),
    inference_mode=contextlib.nullcontext)
class Inputs(dict):
    def to(self,device):return self
class Processor:
    @classmethod
    def from_pretrained(cls,*args,**kwargs):return cls()
    def apply_chat_template(self,*args,**kwargs):
        return Inputs(input_ids=types.SimpleNamespace(shape=[1,1]))
    def decode(self,*args,**kwargs):return 'Polished fixture text.'
class Model:
    @classmethod
    def from_pretrained(cls,*args,**kwargs):return cls()
    def eval(self):return self
    def generate(self,**kwargs):return [[1,2]]
sys.modules['torch']=torch
sys.modules['transformers']=types.SimpleNamespace(AutoProcessor=Processor,AutoModelForMultimodalLM=Model)
raise SystemExit(engine.main())
'''


class BackendIsolation(unittest.TestCase):
    def protocol(self, system, arch, blocked, commands, device="cpu"):
        requests = [{"protocolVersion": 1, "id": str(index), **request} for index, request in enumerate(commands)]
        result = subprocess.run(
            [sys.executable, "-c", PROTOCOL_BOOTSTRAP, str(Path(engine.__file__)),
             system, arch, ",".join(blocked), device],
            input="".join(json.dumps(request) + "\n" for request in requests),
            capture_output=True, text=True, timeout=5,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        responses = [json.loads(line.removeprefix("@delulu:"))
                     for line in result.stdout.splitlines()]
        self.assertEqual([response["id"] for response in responses],
                         [request["id"] for request in requests], result.stderr)
        self.assertTrue(all(response["protocolVersion"] == 1 for response in responses))
        return responses

    def test_idle_commands_do_not_import_unused_backends(self):
        for system, arch, _, _, model, device in PLATFORMS + [
            ("linux", "x86_64", None, None, None, None),
        ]:
            with self.subTest(platform=system), patch.object(sys, "platform", system), \
                    patch.object(engine.platform, "machine", return_value=arch), \
                    forbid_imports(OPTIONAL_MODULES) as attempts:
                worker = engine.Worker()
                expected = {"loaded": False, "model": model, "device": device}
                self.assertEqual(worker.dispatch({"command": "status"}), expected)
                self.assertEqual(worker.dispatch({"command": "ping"})["loaded"], False)
                self.assertEqual(worker.dispatch({"command": "unload"}), {"loaded": False})
                self.assertEqual(worker.dispatch({"command": "magicUnload"}), {"loaded": False})
                self.assertFalse(worker.dispatch({"command": "magicStatus"})["loaded"])
                self.assertEqual(worker.dispatch({"command": "shutdown"}), {"shutdown": True})
                self.assertEqual(attempts, [])

    def test_writing_workflow_works_when_all_speech_backends_are_missing(self):
        blocked = {"metal_speech", "windows_speech", "r2t2", "vllm", "mlx", "mlx_audio"}
        for system, arch in [("darwin", "arm64"), ("win32", "AMD64"), ("linux", "x86_64")]:
            with self.subTest(platform=system):
                responses = self.protocol(system, arch, blocked, [
                    {"command": "ping"},
                    {"command": "magicLoad", "model": "qwen35Small"},
                    {"command": "magicRewrite", "text": "fixture text", "preset": "polish"},
                    {"command": "magicUnload"},
                    {"command": "magicStatus"},
                    {"command": "shutdown"},
                ])
                self.assertTrue(all(response["ok"] for response in responses), responses)
                self.assertTrue(responses[1]["result"]["loaded"])
                self.assertEqual(responses[2]["result"]["text"], "Polished fixture text.")
                self.assertEqual(responses[2]["result"]["model"], "qwen35Small")
                self.assertFalse(responses[4]["result"]["loaded"])

    def test_missing_required_backend_is_confined_to_its_request(self):
        for system, arch, module in [
            ("darwin", "arm64", "metal_speech"),
            ("win32", "AMD64", "windows_speech"),
            ("linux", "x86_64", "r2t2"),
        ]:
            with self.subTest(platform=system):
                responses = self.protocol(system, arch, {module}, [
                    {"command": "ping"},
                    {"command": "load"},
                    {"command": "magicLoad", "model": "qwen35Small"},
                    {"command": "magicStatus"},
                    {"command": "shutdown"},
                ], device="cuda")
                self.assertFalse(responses[1]["ok"])
                self.assertIn(module, responses[1]["error"])
                self.assertTrue(all(response["ok"] for index, response in enumerate(responses) if index != 1))
                self.assertTrue(responses[3]["result"]["loaded"])

    def test_unloaded_native_adapter_cleanup_needs_no_inference_libraries(self):
        for system, arch, module, _, model, device in PLATFORMS:
            with self.subTest(platform=system), patch.object(sys, "platform", system), \
                    patch.object(engine.platform, "machine", return_value=arch), \
                    forbid_imports(OPTIONAL_MODULES - {module}) as attempts:
                worker = engine.Worker()
                with self.assertRaisesRegex(RuntimeError, "not loaded"):
                    worker.dispatch({"command": "transcribe", "audioPath": "unused.wav"})
                self.assertEqual(worker.dispatch({"command": "status"}),
                                 {"loaded": False, "model": model, "device": device})
                self.assertEqual(worker.dispatch({"command": "unload"}), {"loaded": False})
                self.assertEqual(worker.dispatch({"command": "shutdown"}), {"shutdown": True})
                self.assertEqual(attempts, [])

    def test_failed_native_dependency_import_does_not_break_idle_recovery(self):
        for system, arch, module, _, _, _ in PLATFORMS:
            with self.subTest(platform=system), patch.object(sys, "platform", system), \
                    patch.object(engine.platform, "machine", return_value=arch), \
                    forbid_imports(OPTIONAL_MODULES - {module}) as attempts:
                worker = engine.Worker()
                with self.assertRaises(ModuleNotFoundError):
                    worker.dispatch({"command": "load"})
                self.assertEqual(len(attempts), 1)
                self.assertFalse(worker.dispatch({"command": "status"})["loaded"])
                self.assertFalse(worker.dispatch({"command": "magicStatus"})["loaded"])
                self.assertEqual(worker.dispatch({"command": "shutdown"}), {"shutdown": True})
                self.assertEqual(len(attempts), 1)

    def test_cleanup_releases_partial_state_and_existing_allocator_without_model(self):
        for system, arch in [("linux", "x86_64"), ("win32", "AMD64")]:
            clears = []
            torch = types.SimpleNamespace(cuda=types.SimpleNamespace(
                is_available=lambda: True, empty_cache=lambda: clears.append(True)))
            with self.subTest(platform=system), patch.object(sys, "platform", system), \
                    patch.object(engine.platform, "machine", return_value=arch), \
                    patch.dict(sys.modules, {"torch": torch}), \
                    patch.object(engine.gc, "collect") as collect, \
                    forbid_imports({"torch"}) as attempts:
                worker = engine.Worker()
                if system == "win32":
                    with self.assertRaisesRegex(RuntimeError, "not loaded"):
                        worker.dispatch({"command": "transcribe", "audioPath": "unused.wav"})
                    # A processor can exist before loading returns a model.
                    worker.speech.processor = object()
                worker.magic_processor = object()
                worker.magic_model_name = "qwen35Small"
                worker.magic_device = "cuda"
                # Observe these unloads separately from failed-transcribe
                # cleanup performed while acquiring the unloaded adapter.
                clears.clear()
                collect.reset_mock()
                worker.dispatch({"command": "unload"})
                worker.dispatch({"command": "magicUnload"})
                if system == "win32":
                    self.assertIsNone(worker.speech.processor)
                self.assertIsNone(worker.magic_processor)
                self.assertIsNone(worker.magic_model_name)
                self.assertIsNone(worker.magic_device)
                self.assertEqual(clears, [True, True])
                self.assertEqual(collect.call_count, 2)
                self.assertEqual(attempts, [])

    def test_required_import_can_be_repaired_and_retried_without_losing_writing(self):
        for system, arch, module, class_name, model, device in PLATFORMS:
            with self.subTest(platform=system), patch.object(sys, "platform", system), \
                    patch.object(engine.platform, "machine", return_value=arch):
                with forbid_imports({module}):
                    worker = engine.Worker()
                    with self.assertRaisesRegex(ModuleNotFoundError, module):
                        worker.dispatch({"command": "load"})
                self.assertFalse(worker.dispatch({"command": "status"})["loaded"])
                writing_model = object()
                worker.magic_model = writing_model
                calls = []

                class Speech:
                    loaded = False

                    def __init__(self):
                        calls.append("construct")

                    def load(self, request):
                        calls.append("load")
                        self.loaded = True
                        return self.status()

                    def status(self):
                        return {"loaded": self.loaded, "model": model, "device": device}

                    def transcribe(self, request):
                        calls.append("transcribe")
                        return {"text": "R2T2 fixture"}

                    def unload(self):
                        calls.append("unload")
                        self.loaded = False
                        return {"loaded": False}

                with patch.dict(sys.modules, {module: types.SimpleNamespace(**{class_name: Speech})}), \
                        forbid_imports({"transformers", "r2t2", "vllm", "mlx_audio", "torch"}) as attempts:
                    self.assertTrue(worker.dispatch({"command": "load"})["loaded"])
                    self.assertTrue(worker.dispatch({"command": "status"})["loaded"])
                    self.assertEqual(worker.dispatch({"command": "transcribe"})["text"], "R2T2 fixture")
                    worker.dispatch({"command": "unload"})
                    self.assertFalse(worker.dispatch({"command": "status"})["loaded"])
                    self.assertTrue(worker.dispatch({"command": "load"})["loaded"])
                    self.assertIs(worker.magic_model, writing_model)
                    self.assertEqual(attempts, [])
                    self.assertEqual(calls, ["construct", "load", "transcribe", "unload", "load"])


if __name__ == "__main__":
    unittest.main()
