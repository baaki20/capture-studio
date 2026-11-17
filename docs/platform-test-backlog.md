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

## Waiting for the next push (CI)

Written on Linux in step 10; they first run on GitHub's runners after `phase3` is pushed:

- [ ] The end-to-end suite on the Windows and macOS runners (`desktop` job): specs that need only a
      display everywhere, recording specs on Windows (`tests/e2e/platform.ts`). Expect a round of
      platform fixes, as the first Windows/macOS unit and integration runs needed.
- [ ] The capability smoke test (`tests/e2e/capabilities.spec.ts`, acceptance e) on Windows and
      both Macs.
- [ ] Window recording under a window manager on Linux CI (`Window recording E2E` step).

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

## Step 3: macOS permissions

Tested here with a described Mac (`CS_TEST_MAC_PERMISSIONS`, `tests/e2e/permissions.spec.ts`).
On a real Mac:

- [ ] First launch on macOS 13, 14 and 15: Screen Recording not asked yet → the first recording
      shows macOS's prompt; after allowing it (and the restart macOS asks for) recording works.
- [ ] Screen Recording off: the card says so, Record is disabled (audio only still works), "Open
      System Settings" opens Privacy & Security → Screen Recording; turning it on and coming
      back updates the card without restarting.
- [ ] Camera and microphone "Allow…" show macOS's prompt; a refusal leaves only System Settings.
- [ ] Input Monitoring "Allow…" shows macOS's prompt (helper `CGRequestListenEventAccess`); after
      a restart the cursor track has clicks.
- [ ] After an update of an unsigned build macOS forgets the permissions (D3): the card guides
      through granting them again.

## Step 4: native helper

- [ ] Windows: cursor positions and clicks in `cursor.jsonl` line up with the video (S11).
- [ ] macOS: same, with and without Input Monitoring (clicks need it; step 3 corrected this from Accessibility).

## Step 6: on-screen overlays

Tested here on X11 under Xvfb (`tests/e2e/recorder-ui.spec.ts`, region mode). Not yet seen:

- [ ] A real X11 session (log into "Ubuntu on Xorg"): the region picker shows the live desktop
      through its transparent window (needs a compositing window manager; without one it would
      be black), the frame and the highlighter look right, two monitors put them on the
      recorded one.
- [ ] Windows: same, with two monitors and display scaling (125 %, 150 %); the frame stays out of
      the recording (content protection from Windows 10 2004); the highlighter is in it.
- [ ] macOS: same on Retina and with two displays; whether content protection keeps the frame out
      of ScreenCaptureKit captures (S10; otherwise it still never shows in a region crop, being
      drawn outside the region).
- [ ] The highlighter does not appear in **window** recordings (it is a separate window); the
      setup panel offers it only for full screen and region.

## Step 7: all monitors and window recording

"All screens" is Chromium's whole-desktop source (`screen:-1:0`); on X11 it was checked with one
screen (Xvfb cannot fake two monitors here). Window recording from the in-app list is tested on
X11 (`tests/e2e/window-recording.spec.ts`).

- [ ] X11 with two real monitors (an Xorg login): "All screens" records both side by side, the
      cursor track maps over both, and a region over both uses the frozen-frame picker.
- [ ] Windows with two monitors at different scales: same (spike S9 `sources`).
- [ ] macOS: stays one display (`capture.screen.allMonitors` unavailable) unless S10 finds a path.
- [ ] Window recording on Windows and macOS from the in-app list (same code as X11), including a
      window that resizes (letterboxing, Phase 2) and one that closes mid-recording.

## Step 9: packages and updates

- [ ] Windows: install (per user), start, file association `.cstudiopack`, update from an older
      published build, uninstall.
- [ ] macOS: dmg install on both architectures, Gatekeeper with an unsigned build, `.cstudio`
      document package and `.cstudiopack` open from Finder.
- [ ] Signed builds, notarization and macOS auto-update (need the D3 certificates).

## Known gaps to build later (any platform)

Found by the Phase 3 verification (`verification-p3.md`); listed in the 0.3.0 release notes.

- [ ] Recovery after a crash re-adds the cursor track (today it keeps video and audio only).
- [ ] The live highlighter and the on-screen region picker with "All screens" (monitors of
      different scales).
- [ ] Recording without the system cursor in the picture (`capture.cursor.hide`), which the
      editor's smoothing, size and hide need.
- [ ] Detect a missing compositing window manager on X11 and fall back to the frozen-frame
      picker.
- [ ] Software WebGL fallback in the app itself on machines without a usable GPU (macOS VMs show
      "WebGL2 is not available" and the editor preview cannot draw; the tests pass
      `--use-angle=swiftshader` there).
