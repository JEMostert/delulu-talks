"""Synthetic backend failure/retry contracts; no downloads or native inference."""
import contextlib
import copy
import json
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import transcription_engine as engine


class Audio:
    ndim = 1

    def __len__(self):
        return 16000

    def __getitem__(self, key):
        return self


class Inputs(dict):
    def __init__(self, fixture):
        super().__init__(input_ids=types.SimpleNamespace(shape=[1, 1]))
        self.fixture = fixture

    def to(self, device):
        self.fixture.fail("transfer")
        return self


class BackendFixture:
    def __init__(self):
        self.failure = None
        self.once = False
        self.clears = []
        self.loads = []
        self.speech_models = []
        self.rewrite_models = []
        fixture = self

        class SpeechModel:
            def __init__(self):
                self.original = types.SimpleNamespace(max_tokens=4096)
                self.sampling = self.original

            @property
            def sampling_params(self):
                fixture.fail("sampling")
                return self.sampling

            @sampling_params.setter
            def sampling_params(self, value):
                self.sampling = value

            def transcribe(self, **kwargs):
                fixture.fail("warmup" if self.sampling.max_tokens == 8 else "speech_generate")
                if fixture.failure == "speech_output":
                    return []
                return [types.SimpleNamespace(text="R2T2 fixture")]

        def speech_model(**kwargs):
            fixture.loads.append("speech")
            fixture.fail("speech_constructor")
            model = SpeechModel()
            fixture.speech_models.append(model)
            return model

        class Processor:
            @classmethod
            def from_pretrained(cls, *args, **kwargs):
                fixture.fail("processor")
                return cls()

            def apply_chat_template(self, *args, **kwargs):
                fixture.fail("preprocess")
                return Inputs(fixture)

            def decode(self, *args, **kwargs):
                fixture.fail("decode")
                return "" if fixture.failure == "empty_output" else "Rewritten fixture."

        class RewriteModel:
            @classmethod
            def from_pretrained(cls, *args, **kwargs):
                fixture.loads.append("rewrite")
                fixture.fail("rewrite_constructor")
                model = cls()
                fixture.rewrite_models.append(model)
                return model

            def eval(self):
                fixture.fail("eval")
                return self

            def generate(self, **kwargs):
                fixture.fail("rewrite_generate")
                return [[1, 2]]

        def read(*args, **kwargs):
            fixture.fail("audio_decode")
            return Audio(), 16000

        self.torch = types.SimpleNamespace(
            cuda=types.SimpleNamespace(is_available=lambda: True,
                empty_cache=lambda: self.clears.append("cuda")),
            backends=types.SimpleNamespace(mps=types.SimpleNamespace(is_available=lambda: False)),
            mps=types.SimpleNamespace(empty_cache=lambda: self.clears.append("mps")),
            inference_mode=contextlib.nullcontext,
        )
        self.modules = {
            "torch": self.torch,
            "numpy": types.SimpleNamespace(zeros=lambda *a, **kw: Audio(), float32="float32"),
            "qwen_asr": types.SimpleNamespace(Qwen3ASRModel=types.SimpleNamespace(LLM=speech_model)),
            "transformers": types.SimpleNamespace(AutoProcessor=Processor,
                AutoModelForMultimodalLM=RewriteModel),
            "soundfile": types.SimpleNamespace(read=read),
            "librosa": types.SimpleNamespace(load=read),
        }

    def fail(self, stage):
        if self.failure == stage:
            if self.once:
                self.failure = None
            raise RuntimeError("Injected " + stage)


class BackendFailures(unittest.TestCase):
    def setUp(self):
        self.fixture = BackendFixture()
        self.modules = patch.dict(sys.modules, self.fixture.modules)
        self.modules.start()
        self.addCleanup(self.modules.stop)
        self.platform = patch.object(sys, "platform", "linux")
        self.platform.start()
        self.addCleanup(self.platform.stop)
        self.worker = engine.Worker()
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.audio = Path(self.temp.name) / "original.wav"
        self.audio.write_bytes(b"original source fixture")

    def assert_rewrite_empty(self):
        self.assertEqual(self.worker.magic_status(), {"loaded": False, "model": None, "device": None})
        self.assertIsNone(self.worker.magic_processor)

    def test_rewrite_load_failures_clear_partial_state_and_retry_preserves_speech(self):
        self.worker.load({})
        speech = self.worker.model
        for stage in ("processor", "rewrite_constructor", "eval", "import"):
            with self.subTest(stage=stage):
                self.fixture.failure = stage
                missing = {"transformers": None} if stage == "import" else {}
                before = len(self.fixture.loads)
                with patch.dict(sys.modules, missing), self.assertRaises((RuntimeError, ImportError)):
                    self.worker.load_magic({"model": "qwen35Small"})
                self.assert_rewrite_empty()
                self.assertIs(self.worker.model, speech)
                self.assertLessEqual(len(self.fixture.loads) - before, 1)  # no automatic retry
                self.fixture.failure = None
                self.assertTrue(self.worker.load_magic({"model": "qwen35Small"})["loaded"])
                self.assertEqual(self.worker.rewrite_magic({"text": "source", "preset": "polish"})["text"],
                                 "Rewritten fixture.")
                self.worker.unload_magic()

    def test_speech_load_all_phases_rollback_and_explicit_retry_preserves_rewrite(self):
        self.worker.load_magic({"model": "qwen35Small"})
        writing = self.worker.magic_model
        for stage in ("speech_constructor", "numpy", "sampling", "warmup", "import"):
            with self.subTest(stage=stage):
                self.fixture.failure = None
                self.worker.unload()
                self.fixture.failure = stage
                missing = {"numpy": None} if stage == "numpy" else {"qwen_asr": None} if stage == "import" else {}
                with patch.dict(sys.modules, missing), self.assertRaises((RuntimeError, ImportError)):
                    self.worker.load({})
                self.assertEqual(self.worker.status(), {"loaded": False, "model": None, "device": None})
                self.assertIs(self.worker.magic_model, writing)
                if stage == "warmup":
                    failed_model = self.fixture.speech_models[-1]
                    self.assertIs(failed_model.sampling, failed_model.original)
                self.fixture.failure = None
                self.assertTrue(self.worker.load({})["loaded"])
                self.assertIs(self.worker.model.sampling, self.worker.model.original)
                self.worker.unload()

    def test_rewrite_inference_failures_clear_transient_cache_and_allow_same_model_retry(self):
        self.worker.load({})
        self.worker.load_magic({"model": "qwen35Small"})
        speech, model, processor = self.worker.model, self.worker.magic_model, self.worker.magic_processor
        request = {"text": "Original source 42.", "preset": "polish", "allowInferences": False}
        original = copy.deepcopy(request)
        for stage in ("preprocess", "transfer", "rewrite_generate", "decode", "empty_output"):
            with self.subTest(stage=stage):
                self.fixture.failure = stage
                clears = len(self.fixture.clears)
                loads = len(self.fixture.loads)
                with self.assertRaises(RuntimeError):
                    self.worker.rewrite_magic(request)
                self.assertGreater(len(self.fixture.clears), clears)
                self.assertIs(self.worker.magic_model, model)
                self.assertIs(self.worker.magic_processor, processor)
                self.assertIs(self.worker.model, speech)
                self.assertTrue(self.worker.magic_status()["loaded"])
                self.assertEqual(request, original)
                self.fixture.failure = None
                self.assertEqual(self.worker.rewrite_magic(request)["text"], "Rewritten fixture.")
                self.assertEqual(len(self.fixture.loads), loads)

    def test_speech_inference_failures_preserve_original_audio_and_same_model_retry(self):
        self.worker.load({})
        self.worker.load_magic({"model": "qwen35Small"})
        model, writing = self.worker.model, self.worker.magic_model
        request = {"audioPath": str(self.audio), "language": "en"}
        for stage in ("audio_decode", "speech_generate", "speech_output"):
            with self.subTest(stage=stage):
                self.fixture.failure = stage
                clears = len(self.fixture.clears)
                loads = len(self.fixture.loads)
                with self.assertRaises((RuntimeError, IndexError)):
                    self.worker.transcribe(request)
                self.assertGreater(len(self.fixture.clears), clears)
                self.assertIs(self.worker.model, model)
                self.assertIs(self.worker.magic_model, writing)
                self.assertEqual(self.audio.read_bytes(), b"original source fixture")
                self.fixture.failure = None
                self.assertEqual(self.worker.transcribe(request)["text"], "R2T2 fixture")
                self.assertEqual(len(self.fixture.loads), loads)

    def test_mps_cleanup_does_not_depend_on_assigned_model_metadata(self):
        self.fixture.torch.cuda.is_available = lambda: False
        self.fixture.torch.backends.mps.is_available = lambda: True
        self.fixture.failure = "eval"
        with self.assertRaisesRegex(RuntimeError, "Injected eval"):
            self.worker.load_magic({"model": "qwen35Small"})
        self.assert_rewrite_empty()
        self.assertIn("mps", self.fixture.clears)

    def test_native_acquisition_and_partial_load_cleanup_preserve_other_engine(self):
        for system, arch, module, class_name in [
            ("darwin", "arm64", "metal_speech", "MetalSpeech"),
            ("win32", "AMD64", "windows_speech", "WindowsSpeech"),
        ]:
            for stage in ("constructor", "load"):
                with self.subTest(platform=system, stage=stage):
                    failure = [stage]
                    constructed = []
                    clears = []

                    class Native:
                        def __init__(self):
                            if failure[0] == "constructor":
                                raise RuntimeError("native constructor")
                            self.model = None
                            constructed.append(self)

                        def load(self, request):
                            self.model = object()
                            if failure[0] == "load":
                                raise RuntimeError("native load")
                            return self.status()

                        def status(self):
                            return {"loaded": self.model is not None, "model": "R2T2", "device": "fixture"}

                        def unload(self):
                            self.model = None
                            return {"loaded": False}

                    with patch.object(sys, "platform", system), \
                            patch.object(engine.platform, "machine", return_value=arch), \
                            patch.dict(sys.modules, {module: types.SimpleNamespace(**{class_name: Native}),
                                "mlx.core": types.SimpleNamespace(clear_cache=lambda: clears.append(True))}):
                        worker = engine.Worker()
                        worker.magic_model = writing = object()
                        with self.assertRaisesRegex(RuntimeError, "native " + stage):
                            worker.load({})
                        self.assertFalse(worker.status()["loaded"])
                        self.assertIs(worker.magic_model, writing)
                        if constructed:
                            self.assertIsNone(constructed[0].model)
                        if system == "darwin" and stage == "constructor":
                            self.assertTrue(clears)
                        failure[0] = None
                        self.assertTrue(worker.load({})["loaded"])

    def test_cleanup_error_never_replaces_original_backend_cause(self):
        def broken_cleanup():
            raise RuntimeError("cache cleanup failed")
        self.fixture.torch.cuda.empty_cache = broken_cleanup
        self.fixture.failure = "eval"
        with self.assertRaisesRegex(RuntimeError, "Injected eval"):
            self.worker.load_magic({"model": "qwen35Small"})
        self.assert_rewrite_empty()

    def test_sampling_restore_failure_keeps_warmup_cause_and_never_false_ready(self):
        for failed_warmup in (True, False):
            with self.subTest(failed_warmup=failed_warmup):
                class Model:
                    original = types.SimpleNamespace(max_tokens=4096)
                    sampling = original
                    bad_restore = True
                    fail_warmup = failed_warmup

                    @property
                    def sampling_params(self):
                        return self.sampling

                    @sampling_params.setter
                    def sampling_params(self, value):
                        if value is self.original and self.bad_restore:
                            raise RuntimeError("restore failed")
                        self.sampling = value

                    def transcribe(self, **kwargs):
                        if self.fail_warmup:
                            raise RuntimeError("warmup failed")
                        return []

                model = Model()
                healthy = types.SimpleNamespace(sampling_params=model.original, transcribe=lambda **kw: [])
                candidates = iter([model, healthy])
                qwen = types.SimpleNamespace(Qwen3ASRModel=types.SimpleNamespace(LLM=lambda **kw: next(candidates)))
                with patch.dict(sys.modules, {"qwen_asr": qwen}):
                    with self.assertRaisesRegex(RuntimeError, "warmup failed" if failed_warmup else "restore failed"):
                        self.worker.load({})
                    self.assertFalse(self.worker.status()["loaded"])
                    self.assertTrue(self.worker.load({})["loaded"])
                    self.assertIs(self.worker.model, healthy)
                    self.assertIs(healthy.sampling_params, model.original)
                    self.worker.unload()

    def native_modules(self, system, fault):
        from metal_speech import MetalSpeech
        from windows_speech import WindowsSpeech, CONVERSION_VERSION, MODEL_REVISION

        def fail(stage):
            if fault["stage"] == stage:
                raise RuntimeError("Injected native " + stage)

        def cleanup():
            self.fixture.clears.append(system)
            if fault["cleanup"]:
                raise RuntimeError("native allocator failed")

        class Result:
            language = ["Dutch"]
            generation_tokens = 1

            @property
            def text(self):
                fail("decode")
                return "Native fixture"

        def generate(*args, **kwargs):
            fail("generate")
            return Result() if system == "darwin" else [[1, 2]]

        def eval_model():
            fail("load")
            return model

        model = types.SimpleNamespace(device="cuda", dtype="bf16", generate=generate, eval=eval_model)

        def preprocess(**kwargs):
            fail("preprocess")
            return Inputs(self.fixture)

        def decode(*args, **kwargs):
            fail("decode")
            return {"language": "Dutch", "transcription": "Native fixture"}

        processor = types.SimpleNamespace(apply_transcription_request=preprocess, decode=decode)

        def load_audio(*args, **kwargs):
            fail("preprocess")
            return Audio()

        def load_model(*args, **kwargs):
            fail("load")
            return model

        mx = types.SimpleNamespace(clear_cache=cleanup, metal=types.SimpleNamespace(is_available=lambda: True),
                                   zeros=lambda *a, **kw: Audio(), float32="float32")
        mlx = types.ModuleType("mlx")
        mlx.core = mx
        self.fixture.torch.cuda.empty_cache = cleanup
        self.fixture.torch.cuda.is_bf16_supported = lambda: True
        self.fixture.torch.bfloat16, self.fixture.torch.float16 = "bf16", "fp16"
        cache = Path(self.temp.name) / "delulu-r2t2-transformers" / CONVERSION_VERSION / MODEL_REVISION
        cache.mkdir(parents=True, exist_ok=True)
        (cache / "complete").write_bytes(b"existing converted checkpoint fixture")
        modules = {
            "metal_speech": types.SimpleNamespace(MetalSpeech=MetalSpeech),
            "windows_speech": types.SimpleNamespace(WindowsSpeech=WindowsSpeech),
            "mlx": mlx, "mlx.core": mx,
            "mlx_audio": types.ModuleType("mlx_audio"),
            "mlx_audio.stt": types.ModuleType("mlx_audio.stt"),
            "mlx_audio.stt.utils": types.SimpleNamespace(load_audio=load_audio, load_model=load_model),
            "huggingface_hub": types.SimpleNamespace(snapshot_download=lambda **kw: self.temp.name),
            "huggingface_hub.constants": types.SimpleNamespace(HF_HOME=self.temp.name),
            "accelerate": types.SimpleNamespace(init_empty_weights=contextlib.nullcontext),
            "safetensors": types.ModuleType("safetensors"),
            "safetensors.torch": types.SimpleNamespace(load_file=lambda *a, **kw: {}),
            "transformers": types.SimpleNamespace(
                AutoTokenizer=object(), GenerationConfig=object(), Qwen3ASRConfig=object(),
                Qwen3ASRFeatureExtractor=object(),
                Qwen3ASRForConditionalGeneration=types.SimpleNamespace(from_pretrained=lambda *a, **kw: model),
                Qwen3ASRProcessor=types.SimpleNamespace(from_pretrained=lambda *a, **kw: processor)),
        }
        adapter = MetalSpeech() if system == "darwin" else WindowsSpeech()
        adapter.model = model
        if system == "win32":
            adapter.processor = processor
        return modules, adapter, cache

    def test_actual_native_adapter_load_cleanup_keeps_cause_and_allows_retry(self):
        for system, arch in [("darwin", "arm64"), ("win32", "AMD64")]:
            with self.subTest(platform=system):
                fault = {"stage": "load", "cleanup": True}
                modules, _, cache = self.native_modules(system, fault)
                with patch.object(sys, "platform", system), \
                        patch.object(engine.platform, "machine", return_value=arch), \
                        patch.dict(sys.modules, modules):
                    worker = engine.Worker()
                    worker.magic_model = other = object()
                    with self.assertRaisesRegex(RuntimeError, "Injected native load"):
                        worker.load({"cacheDir": self.temp.name})
                    self.assertFalse(worker.status()["loaded"])
                    self.assertIs(worker.magic_model, other)
                    fault["stage"] = None
                    self.assertTrue(worker.load({"cacheDir": self.temp.name})["loaded"])
                    self.assertEqual((cache / "complete").read_bytes(), b"existing converted checkpoint fixture")

    def test_actual_native_prepare_generate_decode_failures_keep_model_and_retry(self):
        for system, arch in [("darwin", "arm64"), ("win32", "AMD64")]:
            for stage in ("preprocess", "generate", "decode"):
                with self.subTest(platform=system, stage=stage):
                    fault = {"stage": stage, "cleanup": stage == "generate"}
                    modules, adapter, _ = self.native_modules(system, fault)
                    with patch.object(sys, "platform", system), \
                            patch.object(engine.platform, "machine", return_value=arch), \
                            patch.dict(sys.modules, modules):
                        worker = engine.Worker()
                        worker.speech = adapter
                        worker.magic_model = other = object()
                        model = adapter.model
                        before = len(self.fixture.clears)
                        request = {"audioPath": str(self.audio), "language": "nl"}
                        with self.assertRaisesRegex(RuntimeError, "Injected native " + stage):
                            worker.transcribe(request)
                        self.assertGreater(len(self.fixture.clears), before)
                        self.assertIs(adapter.model, model)
                        self.assertIs(worker.magic_model, other)
                        self.assertEqual(self.audio.read_bytes(), b"original source fixture")
                        fault["stage"], fault["cleanup"] = None, False
                        self.assertEqual(worker.transcribe(request)["text"], "Native fixture")

    def test_real_protocol_reports_failed_load_as_unloaded_then_accepts_explicit_retry(self):
        bootstrap = r'''
import builtins,sys
sys.path.insert(0,sys.argv[1])
from backend_failure_test import BackendFixture,engine,patch
fixture=BackendFixture();fixture.failure=sys.argv[2];fixture.once=True
sys.platform='linux'
original=builtins.__import__
def guarded(name,*args,**kwargs):
    if name=='numpy' and fixture.failure=='numpy':
        fixture.failure=None
        raise ModuleNotFoundError('Injected missing numpy')
    return original(name,*args,**kwargs)
builtins.__import__=guarded
with patch.dict(sys.modules,fixture.modules):
    raise SystemExit(engine.main())
'''
        for stage, load, status, infer in [
            ("eval", "magicLoad", "magicStatus", "magicRewrite"),
            ("numpy", "load", "status", "transcribe"),
        ]:
            with self.subTest(stage=stage):
                commands = [load, status, load, infer, "shutdown"]
                requests = [{"id": str(i), "command": command, "model": "qwen35Small",
                             "text": "Original fixture.", "preset": "polish", "audioPath": str(self.audio)}
                            for i, command in enumerate(commands)]
                result = subprocess.run(
                    [sys.executable, "-c", bootstrap, str(Path(engine.__file__).parent), stage],
                    input="".join(json.dumps(request) + "\n" for request in requests),
                    capture_output=True, text=True, timeout=5,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                responses = [json.loads(line.removeprefix("@delulu:")) for line in result.stdout.splitlines()]
                self.assertEqual([response["id"] for response in responses], [str(i) for i in range(5)])
                self.assertFalse(responses[0]["ok"])
                self.assertFalse(responses[1]["result"]["loaded"])
                self.assertTrue(responses[2]["ok"])
                self.assertTrue(responses[2]["result"]["loaded"])
                self.assertTrue(responses[3]["ok"])
                self.assertTrue(responses[4]["ok"])


if __name__ == "__main__":
    unittest.main()
