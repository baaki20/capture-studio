# Wayland verification run 2026-10-25 22:47 (dry run)

> Dry run: X11 test mode with fake camera and mic and no GNOME portal. It proves the harness end to end; its numbers say nothing about Wayland capture.

Machine: host test-laptop · kernel redacted · cpus redacted · memory redacted · session wayland · desktop ubuntu:GNOME · electron 45.0.0 · node v24.22.1 · git 1acce43 (phase1-editor, uncommitted changes)

Totals: 2 PASS, 1 FAIL, 5 ERROR, 4 NOT TESTABLE

| Scenario                                                            | Requirements                      | Result       | Time  |
| ------------------------------------------------------------------- | --------------------------------- | ------------ | ----- |
| R1.20 Finalize a 10-minute recording within 10 s                    | R1.20                             | FAIL         | 83 s  |
| W1 Full screen, all components, sync-check pattern                  | R1.24, R1.22, R1.11, R1.13, R1.25 | ERROR        | 101 s |
| W2 Region recording with a pause in the middle                      | R1.14, R1.9, R1.24, R1.32         | ERROR        | 75 s  |
| W3 Stop from the GNOME "stop sharing" indicator                     | R1.15                             | NOT TESTABLE | 0 s   |
| W4 Unplug the USB headset (mic) mid-recording                       | R1.16                             | NOT TESTABLE | 0 s   |
| W5 Cancel the portal dialog                                         | R1.8                              | NOT TESTABLE | 0 s   |
| W6 Fractional scaling, two monitors, region on monitor 2            | R1.9, R1.53                       | NOT TESTABLE | 4 s   |
| W7 SIGKILL during recording, relaunch, recover                      | R1.21, R1.24                      | ERROR        | 54 s  |
| W8 30-minute drift run with the sync-check pattern                  | R1.24                             | ERROR        | 108 s |
| W9 Tray present versus absent                                       | R1.3                              | PASS         | 22 s  |
| W10 Global shortcuts through GNOME custom shortcuts                 | R1.2, R1.4                        | PASS         | 24 s  |
| soak 60-minute soak: dropped frames, memory, drift, preview, export | R1.22, R1.23, R1.24, R1.33, R1.20 | ERROR        | 415 s |

## R1.20: Finalize a 10-minute recording within 10 s — FAIL

| Requirement | Check                         | Result | Value  | Limit  | Detail                                                      |
| ----------- | ----------------------------- | ------ | ------ | ------ | ----------------------------------------------------------- |
| R1.20       | finalize a 1-minute recording | FAIL   | 35.6 s | ≤ 10 s | remux 4.0 s + drift 108 ms + peaks/thumbnails 31.5 s; 60 MB |
| R1.20       | finalize                      | info   | 4.0 s  |        |                                                             |
| R1.20       | thumbnails screen             | info   | 26.0 s |        |                                                             |
| R1.20       | thumbnails camera             | info   | 4.1 s  |        |                                                             |
| R1.20       | peaks mic                     | info   | 0.6 s  |        |                                                             |
| R1.20       | peaks system                  | info   | 0.8 s  |        |                                                             |
| R1.20       | screen finalized              | PASS   | ok     |        |                                                             |
| R1.20       | camera finalized              | PASS   | ok     |        |                                                             |
| R1.20       | mic finalized                 | PASS   | ok     |        |                                                             |
| R1.20       | system finalized              | PASS   | ok     |        |                                                             |

- Quick run: 1 minute instead of 10.

## W1: Full screen, all components, sync-check pattern — ERROR

Human actions: 1 portal click (pick the monitor, Share); camera sees the screen (small mirror by the webcam) or the room lit only by the screen; speakers on; clap 5 times in view of the camera when asked.

| Requirement | Check                                                          | Result | Value                      | Limit   | Detail                                                          |
| ----------- | -------------------------------------------------------------- | ------ | -------------------------- | ------- | --------------------------------------------------------------- |
| R1.11       | controls window state (X11 test mode: not minimized by policy) | info   | minimized                  |         |                                                                 |
| R1.2        | CLI --action stop-recording → finalizing                       | info   | 1564 ms                    |         | includes starting the second instance (2585 ms to exit, code 0) |
| R1.20       | finalizing → project ready                                     | info   | 5.8 s                      |         |                                                                 |
| R1.25       | project.json validates against schema v1                       | PASS   |                            |         |                                                                 |
| R1.25       | recording.state is "complete"                                  | PASS   | complete                   |         |                                                                 |
| R1.25       | every media file exists and probes                             | PASS   | 3/3                        |         |                                                                 |
| R1.13       | one file per enabled stream                                    | PASS   | screen, camera, microphone |         |                                                                 |
| R1.22       | screen dropped frames < 1 %                                    | PASS   | 0.00 %                     | < 1 %   | metrics.json at 0.4 min                                         |
| R1.22       | camera dropped frames < 1 %                                    | PASS   | 0.00 %                     | < 1 %   | metrics.json at 0.4 min                                         |
| R1.19       | screen encoder                                                 | info   | H.264 (software)           |         |                                                                 |
| R1.19       | camera encoder                                                 | info   | H.264 (software)           |         |                                                                 |
| R1.19       | mic encoder                                                    | info   | Opus (WebCodecs)           |         |                                                                 |
| R1.24       | start: screen flashes found                                    | info   | 1                          |         |                                                                 |
| R1.24       | start: screen ↔ system audio                                   | ERROR  |                            |         | no matched events (0 pairs)                                     |
| R1.24       | start: screen ↔ mic                                            | ERROR  |                            |         | no matched events (1 pairs)                                     |
| R1.24       | camera ↔ mic (clap)                                            | PASS   | 49.2 ms                    | ≤ 60 ms | 4 pairs; claps are accurate to about one camera frame           |
| R1.24       | claps heard / paired                                           | info   | 4 / 4                      |         | camera − mic 49.2 ms                                            |
| R1.24       | export: screen ↔ audio mix                                     | FAIL   | 99.2 ms                    | ≤ 40 ms | 13 pairs                                                        |

- Dry run: fake devices and a muted pattern, so audio and camera offsets are not meaningful.

Project: `/tmp/cs-harness-4j8eTL/runs/20261025-224712/projects/Lesson 2026-10-25 22-49.cstudio`

## W2: Region recording with a pause in the middle — ERROR

Human actions: 1 portal click (the region drag and Enter are automated); speakers on.

| Requirement | Check                                    | Result | Value                | Limit | Detail                                                          |
| ----------- | ---------------------------------------- | ------ | -------------------- | ----- | --------------------------------------------------------------- |
| R1.2        | CLI pause → paused                       | info   | 1841 ms              |       |                                                                 |
| R1.2        | CLI --action stop-recording → finalizing | info   | 1683 ms              |       | includes starting the second instance (2721 ms to exit, code 0) |
| R1.20       | finalizing → project ready               | info   | 5.5 s                |       |                                                                 |
| R1.25       | project.json validates against schema v1 | PASS   |                      |       |                                                                 |
| R1.25       | recording.state is "complete"            | PASS   | complete             |       |                                                                 |
| R1.25       | every media file exists and probes       | PASS   | 3/3                  |       |                                                                 |
| R1.14       | one pause recorded                       | PASS   | 1                    |       |                                                                 |
| R1.9        | the region is kept as the screen crop    | PASS   | 1842×1066 at 614,330 |       |                                                                 |
| R1.14       | screen: no frames inside the pause       | PASS   | 0                    |       |                                                                 |
| R1.14       | screen: no pause-mode (red) frames       | PASS   | 0                    | 0     |                                                                 |
| R1.14       | camera: no frames inside the pause       | PASS   | 0                    |       |                                                                 |
| R1.14       | microphone: no pause tone (3 kHz)        | PASS   | absent               |       |                                                                 |
| R1.24       | after resume: screen flashes found       | info   | 1                    |       |                                                                 |
| R1.24       | after resume: screen ↔ system audio      | ERROR  |                      |       | no matched events (0 pairs)                                     |
| R1.24       | after resume: screen ↔ mic               | ERROR  |                      |       | no matched events (1 pairs)                                     |
| R1.32       | Screen: one clip per active interval     | PASS   | 2                    | 2     |                                                                 |
| R1.32       | Face: one clip per active interval       | PASS   | 2                    | 2     |                                                                 |
| R1.32       | Voice: one clip per active interval      | PASS   | 2                    | 2     |                                                                 |

- No TTS phrase during the pause (spd-say not installed, or dry run); the 3 kHz tone stands in.

Project: `/tmp/cs-harness-4j8eTL/runs/20261025-224712/projects/Lesson 2026-10-25 22-50.cstudio`

## W3: Stop from the GNOME "stop sharing" indicator — NOT TESTABLE

Human actions: 1 portal click; 1 click on the top-bar sharing indicator → Stop sharing.

| Requirement | Check                                     | Result       | Value | Limit | Detail                                                      |
| ----------- | ----------------------------------------- | ------------ | ----- | ----- | ----------------------------------------------------------- |
| R1.15       | graceful stop when the screen stream ends | NOT TESTABLE |       |       | needs the GNOME portal or a physical action (real run only) |

## W4: Unplug the USB headset (mic) mid-recording — NOT TESTABLE

Human actions: 1 portal click; unplug the USB headset when asked, plug it back in at the end.

| Requirement | Check                                                    | Result       | Value | Limit | Detail                                                      |
| ----------- | -------------------------------------------------------- | ------------ | ----- | ----- | ----------------------------------------------------------- |
| R1.16       | a disconnected device ends early and recording continues | NOT TESTABLE |       |       | needs the GNOME portal or a physical action (real run only) |

## W5: Cancel the portal dialog — NOT TESTABLE

Human actions: 1 click: Cancel in the portal dialog.

| Requirement | Check                                                | Result       | Value | Limit | Detail                                                      |
| ----------- | ---------------------------------------------------- | ------------ | ----- | ----- | ----------------------------------------------------------- |
| R1.8        | cancelling the portal leaves no project and no error | NOT TESTABLE |       |       | needs the GNOME portal or a physical action (real run only) |

## W6: Fractional scaling, two monitors, region on monitor 2 — NOT TESTABLE

Human actions: set monitor 2 to 125 % (if not already); 1 portal click: pick monitor 2.

| Requirement | Check                                             | Result       | Value                        | Limit | Detail                       |
| ----------- | ------------------------------------------------- | ------------ | ---------------------------- | ----- | ---------------------------- |
| W6          | outputs                                           | info         | Built-in display 1536×864 @2 |       |                              |
| R1.9        | region on a second monitor with a different scale | NOT TESTABLE |                              |       | only one output is connected |

## W7: SIGKILL during recording, relaunch, recover — ERROR

Human actions: 1 portal click.

| Requirement | Check                                     | Result | Value          | Limit   | Detail                      |
| ----------- | ----------------------------------------- | ------ | -------------- | ------- | --------------------------- |
| R1.21       | killed after                              | info   | 10.1 s         |         |                             |
| R1.21       | pw-record processes left after the kill   | info   | 2              |         |                             |
| R1.21       | the next launch offers the recording      | PASS   | 1 candidate(s) |         |                             |
| R1.21       | the main window shows "Recover"           | PASS   | shown          |         |                             |
| R1.21       | project.json validates against schema v1  | PASS   |                |         |                             |
| R1.21       | recording.state is "recovered"            | PASS   | recovered      |         |                             |
| R1.21       | every media file exists and probes        | PASS   | 3/3            |         |                             |
| R1.21       | screen reaches within 2 s of the kill     | FAIL   | ends at 7.0 s  | ≥ 8.1 s |                             |
| R1.21       | camera reaches within 2 s of the kill     | PASS   | ends at 9.0 s  | ≥ 8.1 s |                             |
| R1.21       | microphone reaches within 2 s of the kill | PASS   | ends at 8.9 s  | ≥ 8.1 s |                             |
| R1.24       | recovered: screen flashes found           | info   | 0              |         |                             |
| R1.24       | recovered: screen ↔ system audio          | ERROR  |                |         | no matched events (0 pairs) |
| R1.24       | recovered: screen ↔ mic                   | ERROR  |                |         | no matched events (0 pairs) |

Project: `/tmp/cs-harness-4j8eTL/runs/20261025-224712/projects/Lesson 2026-10-25 22-52.cstudio`

## W8: 30-minute drift run with the sync-check pattern — ERROR

Human actions: 1 portal click; speakers on, leave the machine alone for 30 minutes.

| Requirement | Check                                          | Result | Value    | Limit | Detail                                                          |
| ----------- | ---------------------------------------------- | ------ | -------- | ----- | --------------------------------------------------------------- |
| R1.2        | CLI --action stop-recording → finalizing       | info   | 1555 ms  |       | includes starting the second instance (2442 ms to exit, code 0) |
| R1.20       | finalizing → project ready                     | info   | 9.9 s    |       |                                                                 |
| R1.25       | project.json validates against schema v1       | PASS   |          |       |                                                                 |
| R1.25       | recording.state is "complete"                  | PASS   | complete |       |                                                                 |
| R1.25       | every media file exists and probes             | PASS   | 3/3      |       |                                                                 |
| R1.24       | W8 start (first 2 min): screen flashes found   | info   | 1        |       |                                                                 |
| R1.24       | W8 start (first 2 min): screen ↔ system audio  | ERROR  |          |       | no matched events (0 pairs)                                     |
| R1.24       | W8 start (first 2 min): screen ↔ mic           | ERROR  |          |       | no matched events (1 pairs)                                     |
| R1.24       | W8 at 1 min (short run): screen flashes found  | info   | 1        |       |                                                                 |
| R1.24       | W8 at 1 min (short run): screen ↔ system audio | ERROR  |          |       | no matched events (0 pairs)                                     |
| R1.24       | W8 at 1 min (short run): screen ↔ mic          | ERROR  |          |       | no matched events (1 pairs)                                     |

Project: `/tmp/cs-harness-4j8eTL/runs/20261025-224712/projects/Lesson 2026-10-25 22-52 (2).cstudio`

## W9: Tray present versus absent — PASS

Human actions: 1 portal click per variant (2); disable and re-enable the AppIndicator extension.

| Requirement | Check                                | Result       | Value     | Limit | Detail                                                    |
| ----------- | ------------------------------------ | ------------ | --------- | ----- | --------------------------------------------------------- |
| R1.3        | with AppIndicator: tray icon present | PASS         | true      |       |                                                           |
| R1.3        | tray shows idle                      | PASS         | idle      |       |                                                           |
| R1.3        | tray shows recording                 | PASS         | recording |       |                                                           |
| R1.3        | tray shows paused                    | PASS         | paused    |       |                                                           |
| R1.3        | tray back to idle                    | PASS         | idle      |       |                                                           |
| R1.3        | without a tray                       | NOT TESTABLE |           |       | needs the AppIndicator extension disabled (real run only) |

Project: `/tmp/cs-harness-4j8eTL/runs/20261025-224712/projects/Lesson 2026-10-25 22-54.cstudio`

## W10: Global shortcuts through GNOME custom shortcuts — PASS

Human actions: bind 2 GNOME custom shortcuts once; press them while another window is focused; 1 portal click.

| Requirement | Check                                       | Result       | Value     | Limit | Detail                                                                 |
| ----------- | ------------------------------------------- | ------------ | --------- | ----- | ---------------------------------------------------------------------- |
| R1.4        | portal global shortcuts                     | NOT TESTABLE |           |       | spike S7: no-go on GNOME Wayland (§9.8); custom shortcuts are the path |
| R1.2        | focus before the shortcut                   | info         | focused   |       |                                                                        |
| R1.2        | shortcut starts a recording while unfocused | PASS         | acquiring |       |                                                                        |
| R1.2        | pause shortcut pauses                       | PASS         |           |       |                                                                        |
| R1.2        | pause shortcut resumes                      | PASS         |           |       |                                                                        |
| R1.2        | record shortcut stops                       | PASS         |           |       |                                                                        |
| R1.2        | project.json validates against schema v1    | PASS         |           |       |                                                                        |
| R1.2        | recording.state is "complete"               | PASS         | complete  |       |                                                                        |
| R1.2        | every media file exists and probes          | PASS         | 1/1       |       |                                                                        |

- Dry run: the bound commands are run directly instead of pressing keys.

Project: `/tmp/cs-harness-4j8eTL/runs/20261025-224712/projects/Lesson 2026-10-25 22-54 (2).cstudio`

## soak: 60-minute soak: dropped frames, memory, drift, preview, export — ERROR

Human actions: 1 portal click (region drag and Enter are automated); leave the machine alone for the run.

| Requirement | Check                                            | Result | Value        | Limit     | Detail                                                                               |
| ----------- | ------------------------------------------------ | ------ | ------------ | --------- | ------------------------------------------------------------------------------------ |
| R1.2        | CLI --action stop-recording → finalizing         | info   | 1592 ms      |           | includes starting the second instance (2529 ms to exit, code 0)                      |
| R1.20       | finalizing → project ready                       | info   | 19.0 s       |           |                                                                                      |
| R1.23       | project.json validates against schema v1         | PASS   |              |           |                                                                                      |
| R1.23       | recording.state is "complete"                    | PASS   | complete     |           |                                                                                      |
| R1.23       | every media file exists and probes               | PASS   | 3/3          |           |                                                                                      |
| R1.22       | screen dropped frames < 1 %                      | PASS   | 0.00 %       | < 1 %     | metrics.json at 2.0 min                                                              |
| R1.22       | camera dropped frames < 1 %                      | PASS   | 0.00 %       | < 1 %     | metrics.json at 2.0 min                                                              |
| R1.22       | main-process event-loop delay, worst minute      | info   | 63.8 ms      |           | a proxy only: controls-window input latency (< 100 ms) is not measured automatically |
| R1.23       | memory growth after 1.0 min                      | PASS   | 21 MB        | < 300 MB  | 13 samples; 1796 → peak 1817 MB                                                      |
| R1.23       | main working set                                 | info   | 286 → 287 MB |           |                                                                                      |
| R1.23       | Network Service working set                      | info   | 87 → 87 MB   |           |                                                                                      |
| R1.23       | Capture Studio Media working set                 | info   | 131 → 128 MB |           |                                                                                      |
| R1.23       | shell working set                                | info   | 146 → 146 MB |           |                                                                                      |
| R1.23       | Video Capture working set                        | info   | 98 → 98 MB   |           |                                                                                      |
| R1.23       | Audio Service working set                        | info   | 87 → 87 MB   |           |                                                                                      |
| R1.23       | controls working set                             | info   | 125 → 128 MB |           |                                                                                      |
| R1.23       | engine working set                               | info   | 602 → 614 MB |           |                                                                                      |
| R1.24       | soak start (first 2 min): screen flashes found   | info   | 1            |           |                                                                                      |
| R1.24       | soak start (first 2 min): screen ↔ system audio  | ERROR  |              |           | no matched events (0 pairs)                                                          |
| R1.24       | soak start (first 2 min): screen ↔ mic           | ERROR  |              |           | no matched events (1 pairs)                                                          |
| R1.24       | soak at 2 min (short run): screen flashes found  | info   | 1            |           |                                                                                      |
| R1.24       | soak at 2 min (short run): screen ↔ system audio | ERROR  |              |           | no matched events (0 pairs)                                                          |
| R1.24       | soak at 2 min (short run): screen ↔ mic          | ERROR  |              |           | no matched events (1 pairs)                                                          |
| R1.23       | the project opens in the editor                  | PASS   |              |           |                                                                                      |
| R1.33       | preview late frames < 1 %                        | FAIL   | 27.83 %      | < 1 %     | 32 of 115 (superseded 1, stand-in 31)                                                |
| R1.33       | preview audio underruns                          | FAIL   | 2            | 0         | 22 chunks, 1824 ms late in total                                                     |
| R1.23       | export at Draft                                  | info   | 139 s        |           |                                                                                      |
| R1.46       | export duration = timeline ± 1 frame             | PASS   | 120.877 s    | 120.877 s |                                                                                      |

Project: `/tmp/cs-harness-4j8eTL/runs/20261025-224712/projects/Lesson 2026-10-25 22-55.cstudio`
