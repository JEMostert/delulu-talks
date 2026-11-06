#!/bin/bash
# encode.sh FRAMES_DIR AUDIO.wav OUT.mp4 : H.264 + AAC, web-ready. Uses libx264 when ffmpeg has
# it, otherwise NVIDIA's h264_nvenc, otherwise libopenh264.
set -eu
FR=$1; AU=$2; OUT=$3
enc=$(ffmpeg -hide_banner -encoders 2>/dev/null)
if grep -q ' libx264 ' <<<"$enc"; then V=(-c:v libx264 -preset slow -crf 21 -tune animation)
elif grep -q ' h264_nvenc ' <<<"$enc" && ffmpeg -loglevel error -f lavfi -i color=s=256x256:d=0.1 -c:v h264_nvenc -f null - 2>/dev/null; then
  V=(-c:v h264_nvenc -preset p7 -tune hq -rc vbr -cq 24 -b:v 0 -maxrate 8M -bufsize 16M)
else V=(-c:v libopenh264 -b:v 5M); fi
ffmpeg -loglevel error -y -framerate 60 -i "$FR/%04d.png" -i "$AU" "${V[@]}" -profile:v high -pix_fmt yuv420p \
  -c:a aac -b:a 192k -shortest -movflags +faststart "$OUT"
ls -la "$OUT"
