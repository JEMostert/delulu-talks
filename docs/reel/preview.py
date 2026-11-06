"""The silent, looping README version of the reel, as an animated WebP.

python3 preview.py FRAMES_DIR OUT.webp [WIDTH] [FPS]   (needs Pillow)

Animated WebP rather than GIF: the reel is mostly slow blue gradients, which a 256-colour GIF
can only band or dither (7-13 MB at a smaller size). libwebp's own animation encoder keeps
them smooth at about 4 MB. ffmpeg's libwebp_anim is avoided on purpose: its block
replenishment leaves stale 16 px squares in the gradients."""

import sys
from pathlib import Path

from PIL import Image

frames_dir, out = Path(sys.argv[1]), Path(sys.argv[2])
width = int(sys.argv[3]) if len(sys.argv) > 3 else 960
fps = int(sys.argv[4]) if len(sys.argv) > 4 else 30
files = sorted(frames_dir.glob('[0-9][0-9][0-9][0-9].png'))
step = round(60 / fps)
images = []
for f in files[::step]:
    im = Image.open(f).convert('RGB')
    images.append(im.resize((width, round(im.height * width / im.width)), Image.LANCZOS))
images[0].save(out, save_all=True, append_images=images[1:], duration=1000 / fps, loop=0,
               quality=80, method=4, allow_mixed=False)
print(f'wrote {out} ({len(images)} frames, {out.stat().st_size / 1e6:.1f} MB)')
