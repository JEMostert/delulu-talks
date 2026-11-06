# The reel

The 15-second reel at the top of the [README](../../README.md) is made by the code in this
folder, without a video framework: a canvas program draws every frame, headless Chrome
rasterizes it, a Python synthesizer writes the soundtrack, and ffmpeg encodes the result.

```bash
./make.sh
```

That one command downloads the fonts (first run only), renders the 900 frames, synthesizes
the soundtrack, and writes [`../assets/delulu-talks-reel.mp4`](../assets/delulu-talks-reel.mp4)
(with sound) and [`../assets/delulu-talks-reel.webp`](../assets/delulu-talks-reel.webp) (the
silent loop in the README). It takes about two and a half minutes.

You need `python3` with numpy and scipy, `ffmpeg`, `curl` and a `chrome-headless-shell`.
`render.sh` finds the one Playwright installs (`npx playwright install chromium-headless-shell`);
set `CHROME=/path/to/chrome-headless-shell` to use another. fonttools (for the font cuts) and
Pillow (for the WebP) come from `python3` when it has them, otherwise `uv` fetches them.

## The idea

The reel lives in the app's own world: deep water, a living pearl, mother-of-pearl rims, and
the colours the pearl speaks in (coral while it listens, foam while it thinks, sea glass when
the words land, lavender at rest). The pearl is drawn with the same recipe as the app's
(`ui/src/pearl/draw.ts`). Spoken words are set in Newsreader italic and turn upright once
cleanup has finished with them; everything else is Bricolage Grotesque, as in the app.

| Bar | Time | What happens |
| --- | --- | --- |
| 1 | 0–2.5 s | A calm pearl in the light from the surface. The Super and Z keys rise. |
| 2 | 2.5–5 s | The keys go down, the pearl turns coral, and the sentence is said one syllable per sixteenth note: the voice strings itself as pearls on a thread, as in the recording pill, and each word floats up from its pearls. |
| 3 | 5–7.5 s | The keys come up and the pearl thinks. “um” pops, “monday, no sorry,” is struck through and lifts away as bubbles, “merch” flips to “merge” with the Programming topic, and the line is set in type: “So the merge conflict is on Tuesday.” |
| 4 | 7.5–10 s | A chat window rises and the sentence drops into its message box at the cursor. The pearl bursts into tiny pearls. |
| 5 | 10–12.5 s | Three vocabulary jars: “ghthree code” → T3 Code, “nerve it” → nerf it, “oh bee ess” → OBS. |
| 6 | 12.5–15 s | A rush of bubbles, the name, the line, and a slow return to the first frame, so the loop is seamless. |

## How it fits together

| File | What it does |
| --- | --- |
| `score.json` | The beat map at 96 BPM: the chords, every cue, the spoken syllables and the vocabulary swaps. Picture and sound both read it, so a cue lands on the same frame and sample. |
| `reel.js` | Draws each frame as a pure function of time on a 1920×1080 canvas at 60 fps. Ambient motion (light rays, drifting motes, the pearl's sheen) repeats exactly every 15 s. Motion blur averages four sub-frames over a 180° shutter. |
| `index.html`, `server.py` | The page renders the requested frames and posts each PNG to the server, which writes them to a folder. |
| `render.sh` | Starts the server and a headless Chrome, and waits until every frame is written. |
| `soundtrack.py` | Synthesizes underwater dream pop with numpy and scipy, using no samples: a detuned pad, sub bass, a soft kit, bubble arpeggios, a hummed formant voice that sings each spoken syllable, and glass bells and water drops on every fix. Seeded, so it writes the same `reel.wav` every time, plus `cues.json` with each cue's time and frame. `--spectrogram` also draws `spectrogram.png` (needs matplotlib). |
| `encode.sh` | Encodes the frames and the audio to H.264 and AAC, with libx264, NVENC or OpenH264, whichever ffmpeg has. |
| `preview.py` | Writes the README's looping animated WebP (960 px, 30 fps). A GIF of the same reel is 7–13 MB and bands or dithers the gradients; the WebP is about 4 MB and smooth. |
| `fetch-fonts.sh` | Downloads Bricolage Grotesque and Newsreader from google/fonts with their licences and cuts the static instances the reel uses. |

`./render.sh frames "frames=150,480,800&sub=1"` renders single frames without motion blur,
for checking a layout; `QUERY=... ./make.sh` passes a query through.

## Licences

Bricolage Grotesque (© The Bricolage Grotesque Project Authors) and Newsreader (© The
Newsreader Project Authors) are under the
[SIL Open Font License 1.1](https://openfontlicense.org); `fetch-fonts.sh` saves each licence
next to the fonts. The fonts are downloaded at build time and not committed. Everything else
in the reel, including the soundtrack, is made by the code in this folder and shares the
project's MIT licence.
