# Phase 1 feasibility spikes (spec §4.0)

Run on 2026-10-24 on the dev machine:
- **OS / session:** Ubuntu, GNOME on Wayland. Mutter ScreenCast portal v5; GlobalShortcuts, Screenshot and RemoteDesktop portals are present.
- **Runtime:** Electron 45.0.0 (Chromium 156.0.8078.48), running as a native Wayland client.
- **Hardware:** integrated and discrete GPUs (models not recorded). Display the built-in display at **1920×1080 physical, logical scale 1.25**.
- **Audio:** PipeWire; built-in mic and speakers.

Harnesses are in `spikes/` (throwaway, excluded from lint). Raw results are in `spikes/out/` (git-ignored).

| Spike | Verdict | Decision |
|---|---|---|
| S1 Screen acquisition via portal | **GO** | Path (a): `desktopCapturer.getSources` → `getUserMedia({chromeMediaSourceId})` |
| S2 Shared timestamp domain | **PARTIAL** | Hybrid: shared domain for video, arrival-calibrated for audio |
| S3 Encoder throughput | **GO** (software) | WebCodecs software H.264; no hardware encode on this machine |
| S4 System audio on Linux | **GO** via plan (b) | `pw-record` of the default sink's monitor, in the media utility |
| S5 mediabunny fMP4 | **GO** | Use it, with small write chunks |
| S6 Bundled FFmpeg | **GO** (libx264 only) | `-/filter_complex <file>`; no hardware encoders here |
| S7 Global shortcuts on Wayland | **NO-GO** | Plan B: CLI `--action` plus a GNOME custom shortcut (R1.4) |

---

## S1 — Screen acquisition (GO)
- **Both paths work** on GNOME Wayland:
  - (a) `desktopCapturer.getSources({types:['screen']})` in main shows the portal picker and returns one source (`screen:1:0:s`, "Entire screen"). The engine then calls `getUserMedia({video:{mandatory:{chromeMediaSource:'desktop', chromeMediaSourceId}}})`.
  - (b) `setDisplayMediaRequestHandler` plus `getDisplayMedia` from a click.
- **Decision: path (a).** It needs no user activation in the page, so it works from the hidden capture engine.
- The **portal dialog appears on every acquisition** (as the spec expected). Time from request to stream, including the human click, was 2.3–6.3 s.
- Delivered **29.1–29.9 fps** with `maxFrameRate: 30`, format I420.
- **The `ended` event fires** when the user stops sharing from GNOME's top-bar indicator (round 2, confirmed). R1.15 is feasible.
- **Constraint pitfall:** without `maxWidth`/`maxHeight`, Chromium defaults to a 1920×1080 cap. Always pass the monitor's physical size (or a large cap such as 3840×2160).
  - On this machine the physical mode *is* 1920×1080, so capture beyond 1080p is untested here.
  - The `getSettings()` result echoes the constraint (3840×2160) rather than the real size. **Read the size from the first `VideoFrame`** (`displayWidth`/`displayHeight`), never from `getSettings()`.
- **Fractional scaling:** the portal stream is in physical pixels (1920×1080 at scale 1.25). The region picker must work in stream pixels (spec R1.9 already says "source pixels").

## S2 — Timestamp domains (PARTIAL → hybrid)
Measured as median of (arrival µs − `timestamp` µs) per track, from `MediaStreamTrackProcessor`:

| Track | Rate | Median offset (relative to screen) | First-2 s spread |
|---|---|---|---|
| screen | 29.5 fps | 0 | 0.6–2.1 ms |
| camera (720p requested at 30) | **16.7 fps** | +0.9 to +1.3 ms | 1.5–3.7 ms |
| mic (48 kHz, 1024-frame chunks) | 46.9 chunks/s | **+20.5 s** (different domain) | 15–18 ms |

- **Video tracks share Chromium's capture time domain** (offsets agree to within 1.3 ms). Use one global offset for screen and camera.
- **Mic audio timestamps are in a different domain**, starting near 0 relative to the audio subsystem. Shared-capture mode fails its 250 ms criterion for audio. **Decision:** the sync calibrator uses *shared* mode for video and *arrival-calibrated* mode for each audio track. The project records the mode per media.
  - The arrival spread for audio (15–18 ms) is inside the spec's 30 ms stability bound.
- **Apparent mic drift:** −5 ms over 15–25 s (median of the first 20 vs the last 20 chunks), roughly 200–350 ppm. This is probably arrival jitter, but it is unconfirmed. The checkpoint regression (§1.5) and the 30-minute W8 run will decide. Do not ignore drift for audio.
- **The camera delivered 16.7 fps** although 30 was requested. Likely causes: low-light auto-exposure, or a format limit. Dropped-frame accounting (R1.12, R1.22) must use the camera's **actual delivered rate**, not the requested rate. The setup panel should show the real fps.

## S3 — Encoder throughput (GO, software)
- WebCodecs `isConfigSupported` at 1440p: H.264, VP9 and AV1 are supported with `prefer-software` only. **Hardware encode is unavailable**: Chromium reports `vaInitialize failed` because the VA driver package is not installed, and the discrete GPU has no NVENC.
- **Synthetic max throughput** (OpenH264 software, text-heavy frames):

  | Format | fps |
  |---|---|
  | H.264 1440p | 48.2 |
  | H.264 1080p | 81.6 |
  | H.264 720p | 173 |
  | VP9 1440p | 36.5 |

- **Real-time test** (live screen scaled to 2560×1440 at 30 fps, plus the camera at 720p, both encoded in the same renderer, 25 s): screen **0.14 % dropped** (1/738), camera 0 %, max encode queue 5. Over 15 s: 0 % / 0 %.
- **Decision:** default to H.264 (OpenH264 via WebCodecs) at the source's native size, capped at 1440p (§8).
- **Still open:** the 10-minute soak (R1.22) and the 60-minute memory soak (R1.23) run in the verification step.
- Optional later: installing `intel-media-va-driver-non-free` may enable VAAPI. That is a user decision and is not required.

## S4 — System audio (GO via plan b)
- (a) **Fails:** Chromium lists only "Default" and "Built-in Audio Analog Stereo" as inputs. There are no "Monitor of …" devices under PipeWire.
- (b) **Works:** `pw-record -P '{ stream.capture.sink=true }' --rate 48000 --channels 2` captured the default sink. Over 15 s, all 15 beeps were present (peak −12.0 dB, mean −28.1 dB, 15 silence gaps between them).
- (c) Not needed: `parec` is not installed.
- **Decision:** the media utility spawns `pw-record` writing raw PCM to stdout, timestamps chunks on arrival (arrival-calibrated), and encodes Opus.
  - **Risk:** this is a cross-process clock. The utility's `performance.timeOrigin + now()` must be checked against the engine's. Both are wall-clock anchored, so expect agreement within about 1 ms. Measure this in the recorder build and correct it with a one-time handshake if needed.
  - `audio.system` capability detection: is `pw-record` on PATH and is a PipeWire default sink present?

## S5 — mediabunny 1.62.1 (GO)
- **Writing:** `Output` + `Mp4OutputFormat({fastStart:'fragmented', minimumFragmentDuration:1})` + `StreamTarget`, with positional writes from main through `fs.writeSync(fd, data, 0, len, pos)` and `fsync` every 2 s.
  - Wrote 10 s of 1080p30 H.264 + Opus in 2.5 s, as 4.36 MB.
  - **Writes were strictly append-only** (0 out of order).
  - ffprobe reads all 300 video packets and 501 Opus packets; duration 10.02 s.
- **Crash recovery:** truncating at 55 % of the bytes and running `ffmpeg -c copy -movflags +faststart` gave a clean 5.000 s file (150 video and 199 audio packets) with no errors.
- **Timestamp decode in a worker:** `Input` + `VideoSampleSink.getSample(t)` returned the exact frame for t = 0, 3.3, 5.0, 7.77 and 9.9 s, in **12–42 ms per seek** (keyframes every 2 s).
- **Notes for the build:**
  - With `chunked:true, chunkSize:1 MiB` only 5 writes happened. That buffers up to 1 MiB per stream in memory, which violates "every ≤1 s fragment reaches disk". Use `chunked:false`, or a chunk size small enough that every finished fragment is flushed. Better still, write on `onMoof`/fragment boundaries.
  - Chromium blocks ES-module imports from `file://` pages. This doesn't matter for the app, because electron-vite bundles everything, but spike pages must use the CJS bundle.

## S6 — Bundled FFmpeg n9.0.2 (GO, libx264 only)
- **Hardware encoders:**
  - `h264_vaapi`: **fails** (no VA driver).
  - `h264_qsv`: **fails** (no MFX session).
  - `h264_nvenc`: **fails** (needs driver ≥ 610, and the discrete GPU has no NVENC anyway).
  - **libx264 works.** The P1 export encoder on this machine is libx264.
- **FFmpeg 9 removed `-filter_complex_script`.** Use `-/filter_complex <file>` only (spec §1.10 is updated accordingly).
- **Other checks:** Opus-in-MP4 writes and reads correctly. `asetrate=48000*k,aresample=48000` drift correction works. A truncated fMP4 remuxes cleanly (6.0 s recovered of 10 s at a 60 % cut).
- **Export speed:** libx264 `veryfast` CRF 20 at 1080p30 runs at **5.5× real time**, so a 10-minute lesson exports in about 2 minutes. R1.20's 10 s finalize budget only covers remuxing, which is fast.

## S7 — Global shortcuts on GNOME Wayland (NO-GO)
- `globalShortcut.register('CommandOrControl+Alt+Shift+K')` with `--enable-features=GlobalShortcutsPortal` **returned true, but the shortcut never fired** across two attempts with the window unfocused.
- **Decision:** ship the spec's fallback in P1. Diagnostics shows the exact `capture-studio --action …` command for GNOME Settings → Keyboard → Custom Shortcuts (R1.4). Single-instance forwarding (R1.2) delivers the action.
- Revisit in P3 with a direct D-Bus GlobalShortcuts portal session. That likely needs an installed `.desktop` file and an app ID, which a dev run lacks.
