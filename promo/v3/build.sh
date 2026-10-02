#!/usr/bin/env bash
set -euo pipefail
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")"
node music.mjs
node capture.mjs
ffmpeg -y -i out/video.mp4 -i out/music.wav -map 0:v:0 -map 1:a:0 -c:v copy -af 'loudnorm=I=-15:TP=-1.2:LRA=7,volume=0.8' -ar 48000 -c:a aac -b:a 256k -t 90 -movflags +faststart ../out/miniq-promo-v3.mp4
ffprobe -v error -show_entries format=duration,size:stream=index,codec_name,codec_type,width,height,r_frame_rate,sample_rate,channels -of json ../out/miniq-promo-v3.mp4 > out/ffprobe.json
ffmpeg -v error -i ../out/miniq-promo-v3.mp4 -f null - 2> out/decode.log
