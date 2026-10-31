# FP32 ground truth: ComfyUI's YuE2 modules with every INT8 weight dequantized, on CPU.
import sys, json, numpy as np, torch
sys.path.insert(0, '/home/boran/comfy/ComfyUI')
sys.argv = [sys.argv[0], '--cpu']
import comfy.options; comfy.options.enable_args_parsing()
import comfy_kitchen
comfy_kitchen.flash_attention_decode_is_available = lambda d: False
import comfy.sd, comfy.model_management as mm
from comfy_kitchen.tensor.base import QuantizedTensor
OUT = '/home/boran/agent-work/delulu-music/ref/'
CK = '/home/boran/comfy/ComfyUI/models/checkpoints/yue2_3b_int8_convrot.safetensors'
model, clip, vae, _ = comfy.sd.load_checkpoint_guess_config(CK, output_vae=False, output_clip=True)
def dequant(module):
    n = 0
    for m in module.modules():
        w = getattr(m, 'weight', None)
        if isinstance(w, QuantizedTensor):
            m.weight = torch.nn.Parameter(w.dequantize().float(), requires_grad=False)
            n += 1
    module.float()
    return n
te = clip.cond_stage_model
print('dequantized', dequant(te), dequant(model.model.diffusion_model))
te.set_clip_options({"execution_device": torch.device('cpu')})
prefix = json.load(open(OUT + 'prefix.json'))
ids = json.load(open(OUT + 'cond_ids.json'))
F = 100
prefix2 = ids[:len(ids) - F - 1]
sem = ids[len(prefix2):-1]
with torch.no_grad():
    logits, _, _ = te._prefill([prefix], len(prefix), torch.float32)
    np.asarray(logits[0].float(), dtype='<f4').tofile(OUT + 'prefix_logits32.f32')
    cond, chunks = te._acoustic_conditioning(prefix2, sem, torch.float32)
    dm = model.model.diffusion_model
    x = torch.from_numpy(np.fromfile(OUT + 'x.f32', dtype='<f4').reshape(1, F, 64)).permute(0, 2, 1).contiguous()
    for tval in (1.0, 0.5):
        v = dm(x, torch.tensor([tval]), cond.float(), chunks)
        v.permute(0, 2, 1).contiguous().numpy().astype('<f4').tofile(OUT + f'v32_{tval}.f32')
print('done')
