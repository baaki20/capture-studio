# Wayland verification run 2026-10-30 22:40 (dry run)

> Dry run: X11 test mode with fake camera and mic and no GNOME portal. It proves the harness end to end; its numbers say nothing about Wayland capture.

Machine: host test-laptop · kernel redacted · cpus redacted · memory redacted · session wayland · desktop ubuntu:GNOME · electron 45.0.0 · node v24.22.1 · git 2ad3434 (feature/mcp-automation, uncommitted changes)

Totals: 2 ERROR

| Scenario                                       | Requirements              | Result | Time |
| ---------------------------------------------- | ------------------------- | ------ | ---- |
| W2 Region recording with a pause in the middle | R1.14, R1.9, R1.24, R1.32 | ERROR  | 64 s |
| W7 SIGKILL during recording, relaunch, recover | R1.21, R1.24              | ERROR  | 51 s |

## W2: Region recording with a pause in the middle — ERROR

Human actions: 1 portal click (the region drag and Enter are automated); speakers on.

| Requirement | Check                                    | Result | Value               | Limit | Detail                                                          |
| ----------- | ---------------------------------------- | ------ | ------------------- | ----- | --------------------------------------------------------------- |
| R1.2        | CLI pause → paused                       | info   | 1437 ms             |       |                                                                 |
| R1.2        | CLI --action stop-recording → finalizing | info   | 1481 ms             |       | includes starting the second instance (2374 ms to exit, code 0) |
| R1.20       | finalizing → project ready               | info   | 1.2 s               |       |                                                                 |
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

Project: `/tmp/cs-harness-wkBISK/runs/20261030-224017/projects/Lesson 2026-10-30 22-40.cstudio`

## W7: SIGKILL during recording, relaunch, recover — ERROR

Human actions: 1 portal click.

| Requirement | Check                                     | Result | Value          | Limit   | Detail                                                   |
| ----------- | ----------------------------------------- | ------ | -------------- | ------- | -------------------------------------------------------- |
| R1.21       | killed after                              | info   | 10.2 s         |         |                                                          |
| R1.21       | no capture process outlives the kill      | PASS   | 0              | 0       |                                                          |
| R1.21       | the next launch offers the recording      | PASS   | 1 candidate(s) |         |                                                          |
| R1.21       | the main window shows "Recover"           | PASS   | shown          |         |                                                          |
| R1.21       | project.json validates against schema v1  | PASS   |                |         |                                                          |
| R1.21       | recording.state is "recovered"            | PASS   | recovered      |         |                                                          |
| R1.21       | every media file exists and probes        | PASS   | 3/3            |         |                                                          |
| R1.21       | screen reaches within 2 s of the kill     | PASS   | ends at 8.9 s  | ≥ 8.2 s |                                                          |
| R1.21       | camera reaches within 2 s of the kill     | PASS   | ends at 9.0 s  | ≥ 8.2 s |                                                          |
| R1.21       | microphone reaches within 2 s of the kill | PASS   | ends at 8.9 s  | ≥ 8.2 s |                                                          |
| R1.24       | recovered: screen flashes found           | info   | 4              |         |                                                          |
| R1.24       | recovered: screen ↔ system audio          | ERROR  |                |         | no matched events (0 pairs)                              |
| R1.24       | recovered: screen ↔ mic                   | FAIL   | -281.9 ms      | ≤ 40 ms | 3 pairs, p10 -325.7 ms, p90 187.4 ms, trend -85791.5 ppm |

Project: `/tmp/cs-harness-wkBISK/runs/20261030-224017/projects/Lesson 2026-10-30 22-41.cstudio`
