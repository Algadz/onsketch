# Marketing assets

- `onsketch-demo.mp4`: 32 s demo, 1280×720, H.264 (store review, social posts).
- `onsketch-demo.gif`: the same, 800 px wide, 12 fps.

Recorded from the real editor by `scripts/demo-video.mjs` (Playwright,
a drawn cursor and captions; nothing edited afterwards):

```bash
python3 -m http.server 8099 &
node scripts/demo-video.mjs            # writes marketing/raw/*.webm
V=$(ls -t marketing/raw/*.webm | head -1)
ffmpeg -ss 0.4 -i "$V" -c:v libx264 -pix_fmt yuv420p -crf 20 -movflags +faststart -r 30 marketing/onsketch-demo.mp4
ffmpeg -ss 0.4 -i "$V" -vf "fps=12,scale=800:-1:flags=lanczos,palettegen=max_colors=128:stats_mode=diff" /tmp/pal.png
ffmpeg -ss 0.4 -i "$V" -i /tmp/pal.png -lavfi "fps=12,scale=800:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" marketing/onsketch-demo.gif
```
