#!/bin/sh
set -eu
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")/../.."
# This repository has no backend/pyproject.toml or uv.lock. Use its local Python with NumPy.
python3 promo/v2/music.py
node promo/v2/audio.mjs
node promo/v2/render.mjs
ffmpeg -y -hide_banner -loglevel error -i promo/v2/build/video.mp4 -i promo/v2/build/mix.wav -map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k -t 68 -movflags +faststart promo/out/miniq-promo-v2.mp4
ffmpeg -v error -xerror -i promo/out/miniq-promo-v2.mp4 -f null -
ffprobe -v error -show_format -show_streams -of json promo/out/miniq-promo-v2.mp4 > promo/v2/build/ffprobe.json
