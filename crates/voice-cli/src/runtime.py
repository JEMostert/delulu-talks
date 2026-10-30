"""Private, one-shot Chatterbox Turbo adapter. Never runs a service."""
import json
import os
from pathlib import Path
import sys

# Own dependency overlay supplies pkg_resources for Perth without changing the
# shared Flash/CUDA environment. Set before importing any model dependencies.
sys.path.insert(0, sys.argv[2])
mode, _, config_path = sys.argv[1:4]
config = json.loads(Path(config_path).read_text())


def imports():
    import perth
    from chatterbox.tts_turbo import ChatterboxTurboTTS
    import soundfile
    if perth.PerthImplicitWatermarker is None:
        raise RuntimeError("Perth watermark unavailable; rerun delulu setup to repair the private dependency overlay")
    return ChatterboxTurboTTS


REQUIRED_FILES = [
    "conds.pt", "ve.safetensors", "t3_turbo_v1.safetensors",
    "s3gen_meanflow.safetensors", "tokenizer_config.json", "vocab.json",
    "merges.txt", "added_tokens.json", "special_tokens_map.json",
]

if mode in ("setup", "install"):
    imports()  # Check dependencies without allocating a model on the GPU.
    from huggingface_hub import HfApi, snapshot_download, constants
    from huggingface_hub.errors import LocalEntryNotFoundError
    revision = config.get("revision")
    if not revision:
        try:
            cached = snapshot_download(
                repo_id="ResembleAI/chatterbox-turbo", local_files_only=True,
                allow_patterns=REQUIRED_FILES,
            )
            revision = Path(cached).name
        except LocalEntryNotFoundError:
            # Downloads pinned to a commit need not create a refs/main entry.
            # Reuse a complete snapshot from this official repo's cache in that
            # case, considering only Turbo's required files, never unused assets.
            snapshots = Path(constants.HF_HUB_CACHE) / "models--ResembleAI--chatterbox-turbo" / "snapshots"
            candidates = [p for p in snapshots.glob("*")
                          if len(p.name) == 40 and all(c in "0123456789abcdef" for c in p.name)
                          and all((p / name).is_file() for name in REQUIRED_FILES)]
            if candidates:
                revision = max(candidates, key=lambda p: p.stat().st_mtime).name
    if mode == "install" and not revision:
        revision = HfApi().model_info("ResembleAI/chatterbox-turbo").sha
    try:
        model_dir = snapshot_download(
            repo_id="ResembleAI/chatterbox-turbo", revision=revision,
            local_files_only=mode == "setup",
            allow_patterns=REQUIRED_FILES,
        )
    except Exception:
        if mode != "setup":
            raise
        model_dir = ""
    if not model_dir:
        config.update(model_dir="", revision=revision)
        Path(config_path).write_text(json.dumps(config, indent=2) + "\n")
        sys.exit(0)
    for name in REQUIRED_FILES:
        if not (Path(model_dir) / name).is_file():
            if mode == "setup":
                config.update(model_dir="", revision=revision)
                Path(config_path).write_text(json.dumps(config, indent=2) + "\n")
                sys.exit(0)
            raise RuntimeError(f"Official Turbo snapshot is missing {name}")
    config.update(model_dir=model_dir, revision=revision or Path(model_dir).name)
    Path(config_path).write_text(json.dumps(config, indent=2) + "\n")
else:
    # Speak is offline, including tokenizers and any auxiliary model lookups.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    import numpy as np
    import soundfile as sf
    import torch
    cls = imports()
    device = config["device"]
    if device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA is unavailable; run delulu setup --device cpu or fix the CUDA driver")
    text = Path(sys.argv[4]).read_text()
    with torch.inference_mode():
        model = cls.from_local(config["model_dir"], device=device)
        if config.get("reference"):
            model.prepare_conditionals(config["reference"])
        if model.conds is None:
            raise RuntimeError("No bundled default speaker found; rerun delulu setup")
        wav = model.generate(text)
        samples = wav.detach().float().cpu().numpy().reshape(-1)
        if not samples.size or not np.isfinite(samples).all() or not np.any(samples):
            raise RuntimeError("Turbo returned empty, silent, or non-finite audio")
        sf.write(sys.argv[5], samples, model.sr, subtype="PCM_16")
        print(f"Generated {samples.size / model.sr:.2f}s at {model.sr} Hz", file=sys.stderr)
    # Process exit releases all model and CUDA state before the player starts.
