# Real audio files go here

I couldn't download and embed actual audio bytes myself — my sandbox has no outbound network
access, so I can search/read pages but can't pull down binary files. The game code is fully
wired up to use real recordings the moment they exist in this folder, though: `core.js` tries to
`fetch()` + decode each file below on startup, and only falls back to the old synthesized sound
for whichever one is missing or fails to load. Nothing breaks either way.

Drop these three files in this folder (`assets/audio/`), using exactly these filenames:

| Filename          | What it's for                              | Suggested source (CC0 — no attribution required) |
|-------------------|---------------------------------------------|----------------------------------------------------|
| `engine_loop.mp3` | Continuous engine drone, pitch-shifts with speed | [Jet Turbine Noise](https://freesound.org/people/qubodup/sounds/205581/) by qubodup |
| `wind_loop.mp3`   | Continuous wind, volume follows speed        | [wind-noise.wav](https://freesound.org/people/jorge0000/sounds/361053/) by jorge0000 |
| `splash.mp3`      | One-shot splash on water impact              | [Big Water Splash](https://freesound.org/people/qubodup/sounds/442773/) by qubodup |

All three are CC0 / public domain on Freesound (no login needed to preview, just to download —
you'll need a free Freesound account to hit the actual download button, or use any other CC0/
royalty-free clip you like as long as it's saved under the matching filename above). `.wav` or
`.ogg` work too — just update the filename in `SAMPLE_FILES` near the top of `core.js` if you use
a different extension.

Once the files are in place, refresh the game — you'll hear the real recordings crossfade in
automatically; no other code changes needed.
