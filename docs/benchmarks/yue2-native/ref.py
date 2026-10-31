# Reference tensors from ComfyUI's own YuE2 code (read-only use of the shared install).
import sys, json, numpy as np, torch
sys.path.insert(0, '/home/boran/comfy/ComfyUI')
sys.argv = [sys.argv[0]]
import comfy.options; comfy.options.enable_args_parsing()
import comfy.sd, comfy.model_management as mm, comfy.sample, comfy.samplers
OUT = '/home/boran/agent-work/delulu-music/ref/'
CK = '/home/boran/comfy/ComfyUI/models/checkpoints/yue2_3b_int8_convrot.safetensors'
torch.manual_seed(0)
model, clip, vae, _ = comfy.sd.load_checkpoint_guess_config(CK, output_vae=True, output_clip=True)
te = clip.cond_stage_model
tok = clip.tokenizer
mm.load_model_gpu(clip.patcher)
te.set_clip_options({"execution_device": clip.patcher.load_device})
print("te device", clip.patcher.load_device)
dt = torch.bfloat16
song = json.load(open('/home/boran/agent-work/delulu-music/song1.json'))
abc = open('/home/boran/agent-work/delulu-music/abc1.txt').read()
t = tok.tokenize_with_weights(song['style'], lyrics=song['lyrics'], cot='full', abc=abc)
inner = te
prefix = t['prefix']
json.dump(prefix, open(OUT + 'prefix.json', 'w'))
with torch.no_grad():
    logits, _, _ = inner._prefill([prefix], len(prefix), dt)
np.asarray(logits[0].float().cpu(), dtype='<f4').tofile(OUT + 'prefix_logits.f32')
prefix2 = prefix + t['abc_ids'] + [151848, 151851]
with torch.no_grad():
    sem, _ = inner._generate(prefix2, 7, 100, 'semantic', dt, temperature=1.0, top_p=0.95, top_k=100,
                             repetition_penalty=1.2, penalty_window=50, min_tokens=100)
    cond, chunks = inner._acoustic_conditioning(prefix2, sem, dt)
ids = prefix2 + sem + [151852]
json.dump(ids, open(OUT + 'cond_ids.json', 'w'))
print('prefix', len(prefix), 'prefix2', len(prefix2), 'frames', len(sem), 'chunks', chunks)
F = len(sem)
mm.load_models_gpu([model])
dm = model.model.diffusion_model
dev = mm.get_torch_device()
g = torch.Generator().manual_seed(123)
x = torch.randn(1, 64, F, generator=g)
x.permute(0, 2, 1).contiguous().numpy().astype('<f4').tofile(OUT + 'x.f32')
with torch.no_grad():
    for tval in (1.0, 0.5):
        v = dm(x.to(dev, dt), torch.tensor([tval], device=dev), cond.to(dev, dt), chunks)
        v.float().cpu().permute(0, 2, 1).contiguous().numpy().astype('<f4').tofile(OUT + f'v_{tval}.f32')
    # Full KSampler run from the same noise, as the workflow does.
    positive = [[cond, {"yue2_chunks": chunks}]]
    negative = [[torch.zeros_like(cond), {"yue2_chunks": chunks}]]
    latent = torch.zeros(1, 64, F)
    samples = comfy.sample.sample(model, x, 32, 1.0, 'dpm_2', 'sgm_uniform', positive, negative, latent, denoise=1.0, seed=0)
    samples.float().cpu().permute(0, 2, 1).contiguous().numpy().astype('<f4').tofile(OUT + 'latent.f32')
    audio = vae.decode(samples)
    print('audio', tuple(audio.shape), audio.dtype)
    a = audio.float().cpu()
    a = a.reshape(-1, a.shape[-1]) if a.shape[-1] > 4 else a.movedim(-1, 1).reshape(2, -1)
    a.numpy().astype('<f4').tofile(OUT + 'audio.f32')
print('done')
