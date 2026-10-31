# Compare the native engine's stage outputs (crates/music/examples/parity.rs) with
# ComfyUI's (ref.py) and with an FP32 dequantized reference (ref32.py).
import numpy as np

def load(p):
    return np.fromfile(p, dtype='<f4').astype(np.float64)

def cmp(name, a, b):
    a, b = load(a), load(b)
    n = min(len(a), len(b))
    a, b = a[:n], b[:n]
    cos = a @ b / np.linalg.norm(a) / np.linalg.norm(b)
    snr = 10 * np.log10((b @ b) / ((a - b) @ (a - b)))
    print(f'{name:44s} cosine {cos:.5f}  SNR {snr:5.1f} dB')

print('vs FP32 ground truth')
cmp('ComfyUI LM logits', 'prefix_logits.f32', 'prefix_logits32.f32')
cmp('native  LM logits', 'our_prefix_logits.f32', 'prefix_logits32.f32')
for t in ('1.0', '0.5'):
    cmp(f'ComfyUI DiT velocity t={t}', f'v_{t}.f32', f'v32_{t}.f32')
    cmp(f'native  DiT velocity t={t}', f'our_v_{t}.f32', f'v32_{t}.f32')
print('native vs ComfyUI')
cmp('32-step dpm_2 latent, same noise', 'our_latent.f32', 'latent.f32')
ours = load('our_audio.f32').reshape(-1, 2).T.reshape(-1)
ours.astype('<f4').tofile('our_audio_planar.f32')
cmp('VAE audio, same latent', 'our_audio_planar.f32', 'audio.f32')
