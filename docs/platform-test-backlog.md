# Phase 3: checks waiting for real Windows and macOS machines

Phase 3 is built and tested on Linux (unit tests with injected platforms, Xvfb end-to-end tests)
and on GitHub's Windows and macOS runners (build, unit, integration and package smoke tests). The
runners cannot record a real screen, play sound or grant macOS privacy permissions, so everything
below is **built but not verified** until someone runs it on a real machine. Nothing here is
claimed as working in release notes until its box is ticked.

When a machine is available: run the spike harness first (`docs/spikes/P3-S9-S11.md`), then the
per-OS checklist (step 10), then tick the items here and fix the capabilities that turned out
wrong. Reports use generic stand-ins for devices and machines; recordings are deleted after
analysis.

## Spikes (step 0)

- [ ] **S9 Windows** and **S10 macOS**: run `npx electron spikes/p3-platform/main.cjs`. It decides
      whole-desktop capture (step 7), content protection (step 6), cursor hiding, system audio
      (three variants, see below) and the TCC flow (step 3).
- [ ] **S11** cursor clock: helper click timestamps against a flash target, on X11 (an Xorg login
      here), Windows and macOS (acceptance c).

## Step 2: recording on Windows and macOS

- [ ] **System audio**, Windows: a recording with sound playing has a `system-audio` track with that
      sound; screen ↔ system sync within R1.24 (the W1 clap/flash check).
- [ ] **System audio**, macOS 13, 14 and 15: same. The capability is `degraded` until this passes.
- [ ] **Which loopback path works.** The engine uses Chromium's desktop audio
      (`getUserMedia` with `chromeMediaSource: 'desktop'` audio, the spike's
      `loopbackDesktopAudio`). If on a platform only `loopback` (`getDisplayMedia` +
      `setDisplayMediaRequestHandler({audio: 'loopback'})`) delivers sound, switch the engine to
      that path there. A Linux dry run (2026-11-17) showed `getDisplayMedia` works without a user
      gesture in Electron 45, which the hidden engine window needs.
- [ ] System audio with a **window** source (not a screen): recorded, or a clean "recording without
      it" notice.
- [ ] A capture that carries no audio: the recording goes on with the notice (unit-tested only).
- [ ] **Camera and mic** on both: device lists, hot-unplug notice (R1.16), mic processing toggles.
- [ ] **Hardware encoders**: WebCodecs (Media Foundation on Windows, VideoToolbox on macOS) picked by
      the encoder probe; FFmpeg export with `h264_nvenc` / `h264_qsv` / `h264_amf` on Windows
      hardware and `h264_videotoolbox` on both Mac architectures (the CI runners have no GPU, so
      only libx264 and, maybe, VideoToolbox are exercised there).
- [ ] **Cursor hiding** (`capture.cursor.hide`): stays unavailable until S9/S10 show it works.
- [ ] The **live harness** ported to Windows and macOS scenario sets (sync check W1 first).

## Step 4: native helper

- [ ] Windows: cursor positions and clicks in `cursor.jsonl` line up with the video (S11).
- [ ] macOS: same, with and without Accessibility permission (clicks need it).

## Step 9: packages and updates

- [ ] Windows: install (per user), start, file association `.cstudiopack`, update from an older
      published build, uninstall.
- [ ] macOS: dmg install on both architectures, Gatekeeper with an unsigned build, `.cstudio`
      document package and `.cstudiopack` open from Finder.
- [ ] Signed builds, notarization and macOS auto-update (need the D3 certificates).
