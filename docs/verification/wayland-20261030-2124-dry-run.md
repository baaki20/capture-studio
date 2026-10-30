# Wayland verification run 2026-10-30 21:24 (dry run)

> Dry run: X11 test mode with fake camera and mic and no GNOME portal. It proves the harness end to end; its numbers say nothing about Wayland capture.

Machine: host test-laptop · kernel redacted · cpus redacted · memory redacted · session wayland · desktop ubuntu:GNOME · electron 45.0.0 · node v24.22.1 · git 5d766a8 (phase1-editor, uncommitted changes)

Totals: 1 PASS, 3 ERROR

| Scenario                                            | Requirements                      | Result | Time |
| --------------------------------------------------- | --------------------------------- | ------ | ---- |
| W1 Full screen, all components, sync-check pattern  | R1.24, R1.22, R1.11, R1.13, R1.25 | ERROR  | 66 s |
| W2 Region recording with a pause in the middle      | R1.14, R1.9, R1.24, R1.32         | ERROR  | 66 s |
| W7 SIGKILL during recording, relaunch, recover      | R1.21, R1.24                      | ERROR  | 54 s |
| W10 Global shortcuts through GNOME custom shortcuts | R1.2, R1.4                        | PASS   | 21 s |

## W1: Full screen, all components, sync-check pattern — ERROR

Human actions: 1 portal click (pick the monitor, Share); camera sees the screen (small mirror by the webcam) or the room lit only by the screen; speakers on; clap 5 times in view of the camera when asked.

| Requirement | Check                                                          | Result | Value                      | Limit   | Detail                                                                                                         |
| ----------- | -------------------------------------------------------------- | ------ | -------------------------- | ------- | -------------------------------------------------------------------------------------------------------------- |
| R1.11       | controls window state (X11 test mode: not minimized by policy) | info   | shown                      |         |                                                                                                                |
| R1.2        | CLI --action stop-recording → finalizing                       | info   | 1323 ms                    |         | includes starting the second instance (1977 ms to exit, code 0)                                                |
| R1.20       | finalizing → project ready                                     | info   | 1.0 s                      |         |                                                                                                                |
| R1.25       | project.json validates against schema v1                       | PASS   |                            |         |                                                                                                                |
| R1.25       | recording.state is "complete"                                  | PASS   | complete                   |         |                                                                                                                |
| R1.25       | every media file exists and probes                             | PASS   | 3/3                        |         |                                                                                                                |
| R1.13       | one file per enabled stream                                    | PASS   | screen, camera, microphone |         |                                                                                                                |
| R1.22       | screen dropped frames < 1 %                                    | PASS   | 0.00 %                     | < 1 %   | metrics.json at 0.4 min                                                                                        |
| R1.22       | camera dropped frames < 1 %                                    | PASS   | 0.00 %                     | < 1 %   | metrics.json at 0.4 min                                                                                        |
| R1.19       | screen encoder                                                 | info   | H.264 (software)           |         |                                                                                                                |
| R1.19       | camera encoder                                                 | info   | H.264 (software)           |         |                                                                                                                |
| R1.19       | mic encoder                                                    | info   | Opus (WebCodecs)           |         |                                                                                                                |
| R1.24       | start: screen flashes found                                    | info   | 9                          |         |                                                                                                                |
| R1.24       | start: screen ↔ system audio                                   | ERROR  |                            |         | no matched events (0 pairs)                                                                                    |
| R1.24       | start: screen ↔ mic                                            | FAIL   | 44.2 ms                    | ≤ 40 ms | 6 pairs, p10 30.4 ms, p90 53.1 ms, trend 73.0 ppm                                                              |
| R1.24       | camera ↔ mic                                                   | ERROR  |                            |         | the camera saw no flashes and no claps were paired (aim the camera at the screen or a mirror, or clap in view) |
| R1.24       | claps heard / paired                                           | info   | 4 / 0                      |         |                                                                                                                |
| R1.24       | export: screen ↔ audio mix                                     | FAIL   | 48.3 ms                    | ≤ 40 ms | 3 pairs                                                                                                        |

- Dry run: fake devices and a muted pattern, so audio and camera offsets are not meaningful.

Project: `/tmp/cs-harness-ZdJOjb/runs/20261030-212418/projects/Lesson 2026-10-30 21-24.cstudio`

## W2: Region recording with a pause in the middle — ERROR

Human actions: 1 portal click (the region drag and Enter are automated); speakers on.

| Requirement | Check                                    | Result | Value               | Limit | Detail                                                          |
| ----------- | ---------------------------------------- | ------ | ------------------- | ----- | --------------------------------------------------------------- |
| R1.2        | CLI pause → paused                       | info   | 1614 ms             |       |                                                                 |
| R1.2        | CLI --action stop-recording → finalizing | info   | 1315 ms             |       | includes starting the second instance (1986 ms to exit, code 0) |
| R1.20       | finalizing → project ready               | info   | 0.9 s               |       |                                                                 |
| R1.25       | project.json validates against schema v1 | PASS   |                     |       |                                                                 |
| R1.25       | recording.state is "complete"            | PASS   | complete            |       |                                                                 |
| R1.25       | every media file exists and probes       | PASS   | 3/3                 |       |                                                                 |
| R1.14       | one pause recorded                       | PASS   | 1                   |       |                                                                 |
| R1.9        | the region is kept as the screen crop    | PASS   | 1152×864 at 384,108 |       |                                                                 |
| R1.14       | screen: no frames inside the pause       | PASS   | 0                   |       |                                                                 |
| R1.14       | screen: no pause-mode (red) frames       | PASS   | 0                   | 0     |                                                                 |
| R1.14       | camera: no frames inside the pause       | PASS   | 0                   |       |                                                                 |
| R1.14       | microphone: no pause tone (3 kHz)        | PASS   | absent              |       |                                                                 |
| R1.24       | after resume: screen flashes found       | info   | 5                   |       |                                                                 |
| R1.24       | after resume: screen ↔ system audio      | ERROR  |                     |       | no matched events (0 pairs)                                     |
| R1.24       | after resume: screen ↔ mic               | ERROR  |                     |       | no matched events (2 pairs)                                     |
| R1.32       | Screen: one clip per active interval     | PASS   | 2                   | 2     |                                                                 |
| R1.32       | Face: one clip per active interval       | PASS   | 2                   | 2     |                                                                 |
| R1.32       | Voice: one clip per active interval      | PASS   | 2                   | 2     |                                                                 |

- No TTS phrase during the pause (spd-say not installed, or dry run); the 3 kHz tone stands in.

Project: `/tmp/cs-harness-ZdJOjb/runs/20261030-212418/projects/Lesson 2026-10-30 21-25.cstudio`

## W7: SIGKILL during recording, relaunch, recover — ERROR

Human actions: 1 portal click.

| Requirement | Check                                     | Result | Value          | Limit   | Detail                      |
| ----------- | ----------------------------------------- | ------ | -------------- | ------- | --------------------------- |
| R1.21       | killed after                              | info   | 10.1 s         |         |                             |
| R1.21       | no capture process outlives the kill      | PASS   | 0              | 0       |                             |
| R1.21       | the next launch offers the recording      | PASS   | 1 candidate(s) |         |                             |
| R1.21       | the main window shows "Recover"           | PASS   | shown          |         |                             |
| R1.21       | project.json validates against schema v1  | PASS   |                |         |                             |
| R1.21       | recording.state is "recovered"            | PASS   | recovered      |         |                             |
| R1.21       | every media file exists and probes        | PASS   | 3/3            |         |                             |
| R1.21       | screen reaches within 2 s of the kill     | PASS   | ends at 9.1 s  | ≥ 8.1 s |                             |
| R1.21       | camera reaches within 2 s of the kill     | PASS   | ends at 9.0 s  | ≥ 8.1 s |                             |
| R1.21       | microphone reaches within 2 s of the kill | PASS   | ends at 8.9 s  | ≥ 8.1 s |                             |
| R1.24       | recovered: screen flashes found           | info   | 3              |         |                             |
| R1.24       | recovered: screen ↔ system audio          | ERROR  |                |         | no matched events (0 pairs) |
| R1.24       | recovered: screen ↔ mic                   | ERROR  |                |         | no matched events (2 pairs) |

Project: `/tmp/cs-harness-ZdJOjb/runs/20261030-212418/projects/Lesson 2026-10-30 21-26.cstudio`

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

Project: `/tmp/cs-harness-ZdJOjb/runs/20261030-212418/projects/Lesson 2026-10-30 21-27.cstudio`
