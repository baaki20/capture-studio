# Wayland manual checklist (§4.6.5)

GNOME's ScreenCast portal asks for one click per recording, so Wayland capture cannot run in
CI. The harness in `tests/wayland/` does everything else: it launches the app, tells you what to
click, drives the rest through `capture-studio --action …` and a test-only control channel,
analyzes the recorded projects and writes a report to `docs/verification/`.

Run it before every release, after every Electron upgrade, and after any change to the capture
engine or the acquisition path.

```bash
npm run fetch:ffmpeg          # once
npm run test:wayland          # R1.20, W1–W7, W9, W10 (about 15 minutes, 11–13 clicks)
npm run test:wayland -- W8    # the 30-minute drift run
npm run test:soak             # the 60-minute soak (R1.22, R1.23, W8 at 30 min, preview, export)
npm run test:wayland -- --list
npm run test:wayland -- --dry-run --quick   # X11 test mode, fake devices, nobody needed
```

The first run asks which camera, which microphone hears the speakers (the built-in one) and
which microphone you will unplug in W4 (the USB headset); the choices are remembered in
`~/.cache/capture-studio-harness/`. Type `skip` and Enter while a prompt waits to give up on it.

| #     | You do                                                                     | Checked automatically                                                                                                                                                                                       |
| ----- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1.20 | nothing                                                                    | finalizing a synthetic 10-minute recording takes ≤ 10 s                                                                                                                                                     |
| W1    | portal: pick the monitor, Share; webcam sees the screen; clap 5 times      | R1.24 screen ↔ system, screen ↔ mic ≤ 40 ms, camera ↔ mic ≤ 60 ms (flash or claps), export sync, dropped frames, R1.11                                                                                      |
| W2    | portal click (region drag and Enter are automated)                         | R1.14: no frames in the pause, no red pause-mode frames, no 3 kHz pause tone; R1.24 after resume; R1.32                                                                                                     |
| W3    | portal click; top-bar sharing indicator → Stop sharing                     | R1.15: graceful stop, notice, valid project covering the recording                                                                                                                                          |
| W4    | portal click; unplug the USB headset when asked                            | R1.16: recording continues, mic `endedEarly`, notice names the device                                                                                                                                       |
| W5    | Cancel in the portal                                                       | R1.8: back to the panel, no project folder, no error                                                                                                                                                        |
| W6    | set monitor 2 to 125 %; portal: pick monitor 2                             | region pixel-exact in the export (grid lines); not testable with one output                                                                                                                                 |
| W7    | portal click                                                               | R1.21: SIGKILL, relaunch offers recovery, every stream within 2 s of the kill, `recovered`, R1.24                                                                                                           |
| W8    | portal click; leave the machine alone 30 minutes                           | R1.24 at the start (≤ 40 ms) and at 30 minutes (≤ 60 ms)                                                                                                                                                    |
| W9    | portal click per variant; disable and re-enable the AppIndicator extension | R1.3 tray states; without a tray: CLI works, closing the window quits                                                                                                                                       |
| W10   | bind two GNOME custom shortcuts once; press them unfocused; portal click   | R1.2: start, pause, resume and stop from the shortcuts while unfocused                                                                                                                                      |
| soak  | portal click; leave the machine alone 60 minutes                           | R1.22 dropped < 1 % over 10 minutes, R1.23 memory growth < 300 MB after minute 5, R1.24 at 30 minutes, the project opens, 5 minutes of preview without late frames (< 1 %) or audio underruns, Draft export |

Not automated: controls-window input latency (R1.22; the main-process event-loop delay is
reported as a proxy) and whether the TTS phrase is audible in W2 (listen to the mic track).
