"""Dependency-free Windows adapter contracts; these do not prove CUDA inference."""
import contextlib
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from windows_checkpoint import clean_config, convert_state_dict, STATE_DICT_MAPPING_ASR
from windows_speech import WindowsSpeech, MODEL, MODEL_REVISION, CONVERSION_VERSION


def fake_cuda_preflight(torch):
    # These fixtures exercise model contracts, not a native CUDA probe.
    if not torch.cuda.is_available():
        raise RuntimeError("Synthetic CUDA unavailable")
    return {"probe": "synthetic-no-hardware"}


class WindowsContract(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.source.mkdir()
        (self.source / "config.json").write_text(json.dumps({
            "thinker_config": {"audio_config": {"encoder_attention_heads": 4},
                               "text_config": {"hidden_size": 8}, "audio_token_id": 42},
            "support_languages": ["English"],
        }))
        self.downloads = []
        self.loads = []
        self.warmups = []
        self.clears = []
        self.saved = []
        self.available = True
        self.fail_warmup = False
        self.fail_strict = False

        def save(path):
            self.saved.append(str(path))
            (Path(path) / "test-data").write_text("complete model")

        def strict(state, **kwargs):
            self.assertEqual(kwargs, {"strict": True, "assign": True})
            self.assertEqual(state, {"model.language_model.embed_tokens.weight": "r2t2-weight", "lm_head.weight": "r2t2-weight"})
            if self.fail_strict:
                raise ValueError("checkpoint mismatch")

        self.model = types.SimpleNamespace(
            load_state_dict=strict, to=lambda **kw: self.model, eval=lambda: self.model,
            save_pretrained=save,
        )
        self.processor = types.SimpleNamespace(save_pretrained=save)

        def cached(path, **kwargs):
            self.loads.append((str(path), kwargs))
            return self.model

        def download(**kwargs):
            self.downloads.append(kwargs)
            return str(self.source)

        modules = {
            "accelerate": types.SimpleNamespace(init_empty_weights=lambda **kw: contextlib.nullcontext()),
            "cuda_preflight": types.SimpleNamespace(
                ensure_cuda_compatible=fake_cuda_preflight),
            "torch": types.SimpleNamespace(device=lambda _: contextlib.nullcontext(),
                bfloat16="bf16", float16="fp16",
                cuda=types.SimpleNamespace(is_available=lambda: self.available,
                    is_bf16_supported=lambda: True, empty_cache=lambda: self.clears.append(True))),
            "huggingface_hub": types.SimpleNamespace(snapshot_download=download),
            "huggingface_hub.constants": types.SimpleNamespace(HF_HOME=str(self.root)),
            "safetensors": types.ModuleType("safetensors"),
            "safetensors.torch": types.SimpleNamespace(load_file=lambda *a, **kw:
                {"thinker.model.embed_tokens.weight": "r2t2-weight"}),
            "transformers": types.SimpleNamespace(
                AutoTokenizer=types.SimpleNamespace(from_pretrained=lambda p: "original-r2t2-tokenizer"),
                GenerationConfig=lambda **kw: kw, Qwen3ASRConfig=lambda **kw: types.SimpleNamespace(tie_word_embeddings=True),
                Qwen3ASRFeatureExtractor=lambda: "native-asr-features",
                Qwen3ASRForConditionalGeneration=ModelFactory(self.model, cached),
                Qwen3ASRProcessor=ProcessorFactory(self.processor)),
        }
        self.patch = patch.dict(sys.modules, modules)
        self.patch.start()
        self.speech = WindowsSpeech()

        def warmup():
            self.warmups.append(True)
            if self.fail_warmup:
                raise RuntimeError("decoder failure")
        self.speech._warmup = warmup

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    def test_conversion_cache_and_reload_keep_original_weights(self):
        self.assertTrue(self.speech.load({"cacheDir": str(self.root)})["loaded"])
        self.assertEqual(self.downloads[0]["repo_id"], MODEL)
        self.assertEqual(self.downloads[0]["revision"], MODEL_REVISION)
        cache = self.root / "delulu-r2t2-transformers" / CONVERSION_VERSION / MODEL_REVISION
        self.assertTrue((cache / "complete").is_file())
        self.assertTrue(all("conversion-" in p for p in self.saved))
        self.speech.load({})
        self.assertEqual(len(self.warmups), 1)
        self.speech.unload()
        self.speech.load({"cacheDir": str(self.root)})
        self.assertEqual(self.loads[0][0], str(cache))
        self.assertEqual(self.loads[0][1]["device_map"], {"": "cuda"})
        self.assertEqual(len(self.warmups), 2)

    def test_warmup_failure_clears_model_and_can_retry(self):
        self.fail_warmup = True
        with self.assertRaisesRegex(RuntimeError, "decoder failure"):
            self.speech.load({"cacheDir": str(self.root)})
        self.assertFalse(self.speech.status()["loaded"])
        self.assertIsNone(self.speech.processor)
        self.assertTrue(self.clears)
        self.fail_warmup = False
        self.assertTrue(self.speech.load({"cacheDir": str(self.root)})["loaded"])

    def test_strict_mismatch_never_activates_cache(self):
        self.fail_strict = True
        with self.assertRaisesRegex(ValueError, "checkpoint mismatch"):
            self.speech.load({"cacheDir": str(self.root)})
        self.assertFalse(self.speech.status()["loaded"])
        self.assertFalse((self.root / "delulu-r2t2-transformers" / CONVERSION_VERSION / MODEL_REVISION).exists())

    def test_cuda_required_before_downloading(self):
        self.available = False
        with self.assertRaisesRegex(RuntimeError, "CUDA"):
            self.speech.load({})
        self.assertEqual(self.downloads, [])

    def test_official_key_and_config_conversion(self):
        state = convert_state_dict({
            "thinker.audio_tower.proj1.weight": "audio",
            "thinker.model.layers.0.weight": "text", "thinker.lm_head.weight": "head",
        }, STATE_DICT_MAPPING_ASR)
        self.assertEqual(state, {"model.multi_modal_projector.linear_1.weight": "audio",
            "model.language_model.layers.0.weight": "text", "lm_head.weight": "head"})
        config = clean_config(self.source, "asr")
        self.assertNotIn("thinker_config", config)
        self.assertNotIn("support_languages", config)
        self.assertEqual(config["audio_config"]["num_key_value_heads"], 4)
        self.assertEqual(config["audio_config"]["max_position_embeddings"], 13)
        self.assertEqual(config["audio_token_id"], 42)

    def test_decoder_uses_full_native_processor_and_bounded_generation(self):
        calls = []
        inputs = Inputs()
        self.speech.model = types.SimpleNamespace(device="cuda", dtype="bf16",
            generate=lambda **kw: calls.append(kw) or [TokenSequence()])
        self.speech.processor = types.SimpleNamespace(
            apply_transcription_request=lambda **kw: calls.append(kw) or inputs,
            decode=lambda *a, **kw: {"language": "English", "transcription": "hello"})
        with patch.dict(sys.modules, {"torch": types.SimpleNamespace(inference_mode=contextlib.nullcontext)}):
            result = self.speech._generate("samples", "English", 8)
        self.assertEqual(result["transcription"], "hello")
        self.assertEqual(calls[0]["processor_kwargs"]["audio_kwargs"], {"sampling_rate": 16000})
        self.assertEqual(calls[1]["max_new_tokens"], 8)
        self.assertFalse(calls[1]["do_sample"])

    def test_exhausted_token_budget_never_returns_partial_text(self):
        self.speech.model = types.SimpleNamespace(device="cuda", dtype="bf16",
            generate=lambda **kw: [[0, 0, 0] + [5] * kw["max_new_tokens"]])
        self.speech.processor = types.SimpleNamespace(
            apply_transcription_request=lambda **kw: Inputs(),
            decode=lambda *a, **kw: self.fail("truncated text must not be decoded"))
        with patch.dict(sys.modules, {"torch": types.SimpleNamespace(inference_mode=contextlib.nullcontext)}):
            with self.assertRaisesRegex(RuntimeError, "token limit"):
                self.speech._generate("samples", "English", 4096)

    def test_stereo_import_resamples_and_bounds_each_decoder_chunk(self):
        class Audio:
            def __init__(self, length, ndim=1):
                self.length, self.ndim = length, ndim
            def __len__(self):
                return self.length
            def mean(self, axis):
                assert axis == 1
                return Audio(self.length)
            def __getitem__(self, key):
                return Audio(min(self.length, key.stop) - key.start)
        chunks = []
        self.speech.model = self.model
        def generate(samples, language, limit):
            chunks.append((len(samples), language, limit))
            return {"language": "Dutch", "transcription": "hallo"}
        self.speech._generate = generate
        with patch.dict(sys.modules, {
            "soundfile": types.SimpleNamespace(read=lambda *a, **kw: (Audio(64*48000,2),48000)),
            "soxr": types.SimpleNamespace(resample=lambda a, src, dst: Audio(64*16000)),
            "transcription_engine": types.SimpleNamespace(LANGUAGE_NAMES={"nl":"Dutch"}),
        }):
            result = self.speech.transcribe({"audioPath": str(self.source / "config.json"), "language":"nl"})
        self.assertEqual(chunks, [(480000,"Dutch",4096), (480000,"Dutch",4096), (64000,"Dutch",4096)])
        self.assertEqual(result["text"], "hallo hallo hallo")
        self.assertEqual(result["duration"], 64)
        self.assertEqual(result["language"], "nl")
        self.assertGreaterEqual(result["processingTime"], result["inferenceTime"])


class ModelFactory:
    def __init__(self, model, cached):
        self.model, self.from_pretrained = model, cached
    def __call__(self, config):
        return self.model


class ProcessorFactory:
    def __init__(self, processor):
        self.processor = processor
    def __call__(self, **kwargs):
        assert kwargs["tokenizer"] == "original-r2t2-tokenizer"
        assert "{% generation %}" in kwargs["chat_template"]
        return self.processor
    def from_pretrained(self, path):
        return self.processor


class Inputs(dict):
    def __init__(self):
        super().__init__(input_ids=types.SimpleNamespace(shape=[1, 3]))
    def to(self, _):
        return self


class TokenSequence:
    def __getitem__(self, key):
        assert key == slice(3, None)
        return "generated-only"


if __name__ == "__main__":
    unittest.main()
