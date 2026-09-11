#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -d node_modules/puppeteer-core ]]; then
  npm install --no-fund --no-audit
fi

echo "==> capture 1920x1080 @ 30fps"
node capture.mjs

echo "==> music + sfx"
python3 audio.py

echo "==> mux"
mkdir -p out
ffmpeg -y -hide_banner -loglevel error \
  -i out/video.mp4 \
  -i out/audio.wav \
  -map 0:v:0 -map 1:a:0 \
  -c:v copy \
  -c:a aac -b:a 192k -ar 44100 -ac 2 \
  -shortest \
  -movflags +faststart \
  out/miniq-promo.mp4

echo "==> done  $(ls -lh out/miniq-promo.mp4 | awk '{print $5}')"
echo "    $(pwd)/out/miniq-promo.mp4"
