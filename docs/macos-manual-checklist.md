# macOS manual checklist (Phase 3, acceptance a–c, e, f)

Run on a real Mac with macOS 13, 14 or 15 (both Apple silicon and Intel before a release), with
speakers, a camera and a microphone. GitHub's macOS runners cover the build, unit, integration and
package smoke tests; they cannot grant privacy permissions or record a real screen. Record
results in `docs/verification/` with generic stand-ins for devices and the machine; delete test
recordings after checking them.

Before the list: run the spike harness once (`docs/spikes/P3-S9-S11.md`, S10) and tick the
matching items in `docs/platform-test-backlog.md`.

## Install, permissions and start

| #   | You do                                                                 | Expected                                                                                                                      |
| --- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| I1  | Open the dmg for this Mac's architecture, drag the app to Applications | Gatekeeper warns while builds are unsigned (D3); right-click → Open starts it                                                 |
| I2  | The setup panel on first start                                         | "macOS permissions" lists Screen Recording (not asked yet), camera, microphone and Input Monitoring, each with what it is for |
| I3  | Record full screen                                                     | macOS asks for Screen Recording; after allowing it (and the restart macOS may ask for) recording works                        |
| I4  | Turn Screen Recording off in System Settings, come back                | The card says it is off without a restart; Record is disabled except audio only; "Open System Settings" opens the right pane  |
| I5  | "Allow…" for camera, microphone and Input Monitoring                   | macOS's own prompts; after a restart the cursor track has clicks                                                              |
| I6  | Double-click a `.cstudiopack` and a `.cstudio` project in Finder       | The pack is unpacked into the library and opened; the project opens (one icon in Finder, a document package)                  |
| I7  | Unsigned build: Settings → Updates                                     | Says macOS installs only signed updates. Signed builds (D3): updates from the configured channel                              |

## Recording (R1.5–R1.24 on macOS)

| #   | You do                                                               | Expected                                                                                                                        |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Full screen, camera, mic and system audio, play a video, record 60 s | System audio has the video's sound (or, if this macOS gives none, the notice says so and the rest records)                      |
| R2  | The W1 sync check, 60 s                                              | R1.24 offsets (acceptance b)                                                                                                    |
| R3  | Region mode on a Retina display and a second display                 | The region is drawn over the live desktop; the frame shows while recording; note whether it appears in the recording (macOS 15) |
| R4  | Window mode from the list; resize the window                         | Only that window, letterboxed                                                                                                   |
| R5  | "Highlight the pointer" on, click around, then cursor effects        | The highlight is in the picture; click rings land on the clicks (acceptance c)                                                  |
| R6  | Pause with sound playing; unplug a USB mic; force-quit and relaunch  | R1.14, R1.16, R1.21 as on Linux                                                                                                 |
| R7  | Controls window during a full-screen recording                       | macOS 13–14: not in the recording. macOS 15: minimized when recording starts (until S10 says content protection works)          |
| R8  | App menu, Dock icon click, Cmd+Q during a recording                  | The macOS app menu works; Dock click shows the window; quitting asks first                                                      |

## Editor and export

| #   | You do                                                                 | Expected                                                                       |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| E1  | Export MP4 with the "Auto" encoder                                     | `h264_videotoolbox` is used on both architectures; the file plays in QuickTime |
| E2  | Projects folder on an external drive, a name with non-ASCII characters | Recording, editing and export work                                             |
