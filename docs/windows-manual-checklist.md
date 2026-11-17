# Windows manual checklist (Phase 3, acceptance a–c, e, f)

Run on a real Windows 10 (2004 or later) or Windows 11 machine with a display, speakers, a webcam
and a microphone, before every release that changes recording, packaging or the native helper.
GitHub's Windows runner covers the build, unit, integration and package smoke tests; it cannot
record a real screen or play sound, so these items are manual. Record results in
`docs/verification/` with generic stand-ins for devices and the machine (no names, paths or
serial numbers); delete the test recordings after checking them.

Before the list: run the spike harness once (`docs/spikes/P3-S9-S11.md`) and tick the matching
items in `docs/platform-test-backlog.md`.

## Install and start

| #   | You do                                                          | Expected                                                                                                      |
| --- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| I1  | Run `capture-studio-setup-<version>-x64.exe`, keep the defaults | Per-user install, Start menu entry, the app starts; SmartScreen warns while builds are unsigned (D3)          |
| I2  | Settings → Diagnostics                                          | Every capability with state and reason; `audio.system` desktop-loopback, `capture.cursor.track` native-helper |
| I3  | Double-click a `.cstudiopack`                                   | The app opens, unpacks it into the library and opens the project                                              |
| I4  | Install an older published build, then let it update            | Settings → Updates downloads the new version; "Restart and update" installs it                                |
| I5  | Uninstall from Settings → Apps                                  | The app is gone; projects in `Videos\Capture Studio` stay                                                     |

## Recording (R1.5–R1.24 on Windows)

| #   | You do                                                                 | Expected                                                                                                                              |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Full screen, camera, mic and system audio, play a video, record 60 s   | Four tracks; the system audio has the video's sound; no dropped-frame warning (R1.22 for 10 minutes before a release)                 |
| R2  | The W1 sync check (flash and beep pattern, webcam on the screen), 60 s | R1.24: screen ↔ system and screen ↔ mic ≤ 40 ms, camera ↔ mic ≤ 60 ms (acceptance b)                                                  |
| R3  | Region mode with two monitors at 100 % and 150 %                       | The region is drawn over the live desktop of the recorded monitor; the dashed frame shows while recording and is not in the recording |
| R4  | Source picker → "All screens"                                          | Both monitors side by side in one picture; the cursor track follows across both                                                       |
| R5  | Window mode, pick a window from the list, resize it while recording    | Only that window, letterboxed after the resize, never stretched                                                                       |
| R6  | Turn on "Highlight the pointer", record full screen                    | The yellow circle follows the pointer in the recording                                                                                |
| R7  | Click around while recording, then open the editor's cursor effects    | Click rings appear at the clicks (within one frame, acceptance c); auto-zoom proposes zooms there                                     |
| R8  | Pause with sound playing, resume                                       | R1.14: nothing from the paused span in any track                                                                                      |
| R9  | Unplug the USB microphone while recording                              | R1.16: recording goes on, the mic ends early, the notice names the device                                                             |
| R10 | End the process in Task Manager while recording, start again           | R1.21: "Recover recording" offered; the recovered project has every stream to within 2 s                                              |
| R11 | Controls window during a full-screen recording                         | Not in the recording (content protection, Windows 10 2004 or later)                                                                   |
| R12 | Global shortcuts for start/stop/pause while another app has focus      | R1.2: they work unfocused                                                                                                             |
| R13 | Tray icon                                                              | R1.3: idle and recording states, the menu works                                                                                       |

## Editor and export (R1.25–R1.49)

The end-to-end suite covers the editor on Linux; on Windows check the platform-dependent parts:

| #   | You do                                                                       | Expected                                                                                        |
| --- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| E1  | Open a recording, edit, kill the app during a save, reopen                   | R1.28: the previous version opens                                                               |
| E2  | Export MP4 with "Auto" encoder on a machine with an NVIDIA, Intel or AMD GPU | `h264_nvenc`, `h264_qsv` or `h264_amf` is used (Diagnostics and the export log); the file plays |
| E3  | Cancel an export                                                             | R1.47: no partial file                                                                          |
| E4  | Projects on another drive (`D:\…`) and a name with non-ASCII characters      | Recording, editing and export work                                                              |
