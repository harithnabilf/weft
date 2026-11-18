# Weft

**Weave music with your hands.** Weft is a seated, hands-first WebXR instrument for Meta Quest. Pinch and draw threads of light in the air in front of you. A slow sweep of light, the shuttle, crosses the loom, and every thread it touches sings from the exact spot where you drew it.

**Play it:** https://harithnabilf.github.io/weft/ (open in the Meta Quest Browser and press **Enter XR**; hand tracking on, no controllers needed).

Entry for the Meta VR Start Developer Competition 2026, Entertainment track, New Experience division.

## How it plays

| Gesture | What happens |
| --- | --- |
| **Pinch and draw** | Leaves a glowing thread, and you hear the melody as you draw it |
| **Let go** | The thread joins the loop; the shuttle plays it every pass |
| **Touch a thread** | Plucks it, like a harp string |
| **Clap** | Clears the loom |

The loom maps space to music:

- **Left to right** is time: 16 steps, about 6 seconds per pass.
- **Height** is pitch, snapped to today's scale so every stroke sounds good.
- **Depth** is timbre: near threads are bright and short, far threads are soft and long.
- **Left hand** plays warm low strings. **Right hand** plays glass bells.
- A **vertical stroke** inside one step becomes a chord.

Every note is spatialised (HRTF) at the point where its thread was drawn, so the music comes from the air around you.

**Coming back:** your weave is saved on the device. Each day brings a new tuning (seven scales, one per weekday), so yesterday's weave sounds new today.

## Designed for a seat

- Everything fits within arm's reach, in a 140° arc in front of you, from lap to eye level. It passes the airplane-seat test.
- The loom calibrates to your head when the session starts, so it works at any seat height.
- It is fully usable with hands and works one-handed.
- It teaches itself without a wall of text. A ghost fingertip draws a demo thread that plays immediately, followed by three short hints: *Pinch and draw*, *Touch a thread to pluck it*, *Clap to clear the loom*.
- Every sound has a matching visual pulse, so the rhythm can be followed without audio.

## Built with

- [Immersive Web SDK (IWSDK) 1.1](https://iwsdk.dev): World and ECS systems, WebXR hand tracking (25-joint hand skeleton), Three.js (super-three r185)
- Web Audio API: every sound is synthesised live (additive bell partials, plucked strings, a convolution reverb generated in code, HRTF panners). There are no samples and no third-party services.
- IWER (Immersive Web Emulation Runtime) for development and for recording the demo. The video is a real session driven through IWER's programmatic hand API (`src/demo.ts`, dev builds only).

## Run locally

```bash
npm install
npm run dev:runtime   # http://localhost:8081 with the IWER emulator
npm run build         # static build in dist/
```

## Code

- `src/weft.ts`: the loom, hand tracking (pinch with hysteresis, pluck and clap detection), threads, sequencer, onboarding
- `src/audio.ts`: the synthesis engine and the daily tunings
- `src/demo.ts`: the scripted IWER session used to record the video (dev only)

MIT licensed.
