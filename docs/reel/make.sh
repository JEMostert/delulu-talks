#!/bin/bash
# make.sh : build the whole reel from source into docs/assets: fonts, frames, soundtrack, the MP4
# with sound and the looping WebP for the README.
# Needs: python3 with numpy and scipy, ffmpeg, curl and a chrome-headless-shell (see README.md).
# fonttools (first font download) and Pillow (the WebP) come from python3 if it has them, else uv.
set -eu
R=$(cd "$(dirname "$0")" && pwd); A="$R/../assets"
cd "$R"
[ -f fonts/Display.ttf ] || ./fetch-fonts.sh
./render.sh frames "${QUERY:-from=0&to=900&sub=4}"
python3 soundtrack.py reel.wav
./encode.sh frames reel.wav "$A/delulu-talks-reel.mp4"
if python3 -c "import PIL" 2>/dev/null; then py=(python3); else py=(uv run -q --no-project --with pillow python); fi
"${py[@]}" preview.py frames "$A/delulu-talks-reel.webp"
