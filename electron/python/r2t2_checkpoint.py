# Copyright 2026 The HuggingFace Inc. team. All rights reserved.
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing, software distributed
# under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
# CONDITIONS OF ANY KIND, either express or implied. See the License for the
# specific language governing permissions and limitations under the License.
"""Pure helpers from HuggingFace's official Qwen3-ASR converter.
Source: https://github.com/huggingface/transformers/blob/f4410762062c274fb53471e551e62b377df44cc1/src/transformers/models/qwen3_asr/convert_qwen3_asr_to_hf.py
The pip wheel omits conversion scripts. These helpers retain the R2T2 fine-tune
while translating original Qwen checkpoint layout to native Transformers.
"""
import json
from pathlib import Path
from typing import Any

STATE_DICT_MAPPING_ASR = {
    "thinker.model.": "model.language_model.",
    "thinker.lm_head.": "lm_head.",
    "thinker.": "model.",
    "model.audio_tower.proj1.": "model.multi_modal_projector.linear_1.",
    "model.audio_tower.proj2.": "model.multi_modal_projector.linear_2.",
}

def convert_state_dict(original_state_dict: dict[str, Any], mapping: dict[str, str]) -> dict[str, Any]:
    """Convert checkpoint state dict to transformers format."""
    converted = {}
    for k, v in original_state_dict.items():
        for old_prefix, new_prefix in mapping.items():
            k = k.replace(old_prefix, new_prefix)
        converted[k] = v
    return converted

def clean_config(src_root: Path, model_type: str) -> dict:
    """Load and clean up the source config for transformers compatibility."""
    config_path = src_root / "config.json"
    with open(config_path, "r", encoding="utf-8") as f:
        model_config = json.load(f)

    config_dict = model_config.copy()

    # fmt: off
    # Remove unused top-level keys
    for key in ["support_languages"]:
        config_dict.pop(key, None)

    # Flatten thinker_config structure
    if "thinker_config" in config_dict:
        thinker_config = config_dict.pop("thinker_config")
        if "audio_config" in thinker_config:
            config_dict["audio_config"] = thinker_config["audio_config"]
        if "text_config" in thinker_config:
            config_dict["text_config"] = thinker_config["text_config"]
        if "audio_token_id" in thinker_config:
            config_dict["audio_token_id"] = thinker_config["audio_token_id"]
        if "initializer_range" in thinker_config:
            config_dict["initializer_range"] = thinker_config["initializer_range"]
        # Forced aligner specific
        if model_type == "forced_aligner" and "classify_num" in thinker_config:
            config_dict["num_labels"] = thinker_config["classify_num"]

    # Audio config: rename Whisper-style field names
    if "audio_config" in config_dict:
        audio_renames = {"encoder_attention_heads": "num_attention_heads"}
        for old_name, new_name in audio_renames.items():
            if old_name in config_dict["audio_config"]:
                config_dict["audio_config"][new_name] = config_dict["audio_config"].pop(old_name)

        # Also set num_key_value_heads = num_attention_heads (MHA, no GQA in the encoder)
        if "num_key_value_heads" not in config_dict["audio_config"] and "num_attention_heads" in config_dict["audio_config"]:
            config_dict["audio_config"]["num_key_value_heads"] = config_dict["audio_config"]["num_attention_heads"]

        # Override max_source_positions: the original checkpoint uses 1500 (inherited from Whisper/OmniMoe),
        # but Qwen3ASR chunks are fixed at n_window*2=100 mel frames → 13 post-CNN positions.
        config_dict["audio_config"]["max_position_embeddings"] = 13

    # Audio config: strip non-standard fields
    if "audio_config" in config_dict:
        audio_unused = [
            "_name_or_path", "architectures", "dtype", "model_type", "use_bfloat16", "add_cross_attention",
            "chunk_size_feed_forward", "cross_attention_hidden_size", "decoder_start_token_id",
            "finetuning_task", "id2label", "label2id", "is_decoder", "is_encoder_decoder", "max_source_positions",
            "output_attentions", "output_hidden_states", "pad_token_id", "bos_token_id", "eos_token_id",
            "prefix", "problem_type", "pruned_heads", "return_dict", "sep_token_id", "task_specific_params",
            "tf_legacy_loss", "tie_encoder_decoder", "tie_word_embeddings", "tokenizer_class", "torchscript",
        ]
        for key in audio_unused:
            config_dict["audio_config"].pop(key, None)

    # Text config: strip non-standard fields + MoE fields + M-RoPE fields
    if "text_config" in config_dict:
        text_unused = [
            "_name_or_path", "architectures", "dtype", "model_type", "use_bfloat16", "add_cross_attention",
            "chunk_size_feed_forward", "cross_attention_hidden_size", "decoder_start_token_id",
            "finetuning_task", "id2label", "label2id", "is_decoder", "is_encoder_decoder",
            "output_attentions", "output_hidden_states", "prefix", "problem_type", "pruned_heads",
            "return_dict", "sep_token_id", "task_specific_params", "tf_legacy_loss", "tie_encoder_decoder",
            "tokenizer_class", "torchscript",
            # MoE-specific fields
            "decoder_sparse_step", "moe_intermediate_size", "num_experts_per_tok", "num_experts",
            "norm_topk_prob", "output_router_logits", "router_aux_loss_coef", "mlp_only_layers",
        ]
        for key in text_unused:
            config_dict["text_config"].pop(key, None)

        # Strip M-RoPE fields from rope_scaling
        rope_cfg = config_dict["text_config"].get("rope_scaling")
        if isinstance(rope_cfg, dict):
            for mrope_key in ["mrope_interleaved", "interleaved", "mrope_section", "type"]:
                rope_cfg.pop(mrope_key, None)
    # fmt: on

    return config_dict

ASR_CHAT_TEMPLATE = (
    "{%- set ns = namespace(system_text='') -%}"
    "{%- for m in messages -%}"
    "{%- if m.role == 'system' -%}"
    "{%- if m.content is string -%}"
    "{%- set ns.system_text = ns.system_text + m.content -%}"
    "{%- else -%}"
    "{%- for c in m.content -%}"
    "{%- if c.type == 'text' and (c.text is defined) -%}"
    "{%- set ns.system_text = ns.system_text + c.text -%}"
    "{%- endif -%}"
    "{%- endfor -%}"
    "{%- endif -%}"
    "{%- endif -%}"
    "{%- endfor -%}"
    "{%- set ns2 = namespace(audio_tokens='') -%}"
    "{%- for m in messages -%}"
    "{%- if m.content is not string -%}"
    "{%- for c in m.content -%}"
    "{%- if c.type == 'audio' or ('audio' in c) or ('audio_url' in c) -%}"
    "{%- set ns2.audio_tokens = ns2.audio_tokens + '<|audio_start|><|audio_pad|><|audio_end|>' -%}"
    "{%- endif -%}"
    "{%- endfor -%}"
    "{%- endif -%}"
    "{%- endfor -%}"
    "{{- '<|im_start|>system\n' + ns.system_text + '<|im_end|>\n' -}}"
    "{{- '<|im_start|>user\n' + ns2.audio_tokens + '<|im_end|>\n' -}}"
    "{%- for m in messages -%}"
    "{%- if m.role == 'assistant' -%}"
    "{%- set ns3 = namespace(assistant_text='') -%}"
    "{%- if m.content is string -%}"
    "{%- set ns3.assistant_text = m.content -%}"
    "{%- else -%}"
    "{%- for c in m.content -%}"
    "{%- if c.type == 'text' and (c.text is defined) -%}"
    "{%- set ns3.assistant_text = ns3.assistant_text + c.text -%}"
    "{%- endif -%}"
    "{%- endfor -%}"
    "{%- endif -%}"
    "{{- '<|im_start|>assistant\n' -}}"
    "{% generation %}"
    "{{- ns3.assistant_text + '<|im_end|>\n' -}}"
    "{% endgeneration %}"
    "{%- endif -%}"
    "{%- endfor -%}"
    "{%- if add_generation_prompt -%}"
    "{{- '<|im_start|>assistant\n' -}}"
    "{%- endif -%}"
)
