# Capture Studio

Screen recorder with a teaching-focused video editor, built on Electron and TypeScript.
Copyright (C) 2026 baaki20 <huduabdulbaakijunior20@gmail.com>

Capture Studio is free software: you can redistribute it and/or modify it under the terms of the
GNU General Public License as published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version. It is distributed in the hope that it will be
useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
FOR A PARTICULAR PURPOSE. See `LICENSE` for the full text.

## Development

Node 24 is required (`.nvmrc`):

```sh
nvm use               # or: export PATH="$HOME/.nvm/versions/node/v24.22.1/bin:$PATH"
npm install
node node_modules/electron/install.js   # downloads the Electron binary (also done lazily on first run)
npm run fetch:ffmpeg  # pinned, SHA-256 verified FFmpeg + ffprobe into resources/bin/
npm run dev
```

| Script                  | What it does                                                         |
| ----------------------- | -------------------------------------------------------------------- |
| `npm run dev`           | electron-vite dev server with HMR                                    |
| `npm run build`         | production bundles in `out/`                                         |
| `npm run lint`          | ESLint (including process-boundary import zones) and Prettier check  |
| `npm run typecheck`     | `tsc` for the Node side, the renderer, the pure shared core and E2E  |
| `npm test`              | Vitest unit tests and the FFmpeg integration smoke test              |
| `npm run test:e2e`      | builds, then runs Playwright `_electron` tests                       |
| `npm run fetch:ffmpeg`  | downloads the pinned FFmpeg build for this platform                  |
| `npm run gen:schema`    | regenerates `docs/schemas/project-1.schema.json` from the zod schema |
| `npm run gen:icons`     | regenerates the app icons in `build/` from `scripts/icon-art.ts`     |
| `npm run package:linux` | AppImage and deb in `dist/`                                          |
| `npm run smoke:linux`   | checks the packages in `dist/` and launches each once (no install)   |
| `npm run mcp`           | the MCP server for AI assistants (stdio; see below)                  |

Environment switches:

- `CS_FORCE_X11=1` runs under XWayland instead of native Wayland.
- `CS_USER_DATA_DIR=<dir>` uses a separate profile (settings, logs, single-instance lock);
  development builds only.
- `CS_FFMPEG_DIR=<dir>` uses FFmpeg binaries from another folder; development builds only.
- `CS_TEST=1` is the end-to-end test mode; development builds only.

## Assistants (MCP)

AI assistants such as Claude Code can edit and export projects in the running app with natural
language ("cut the first 3 seconds and remove the long pauses, then export 720p").

1. In the app, turn on **Settings → Assistants → Allow assistants to edit and export projects**.
   This opens a socket at `<userData>/automation/automation.sock` (private to your user; off by
   default).
2. Connect the MCP server (`src/mcp/server.ts`, run with `tsx`). In this repository `.mcp.json`
   registers it for Claude Code; elsewhere, use the command under **Settings → Diagnostics →
   Assistants (MCP)**. Set `CS_AUTOMATION_SOCKET` when the app uses another profile
   (`CS_USER_DATA_DIR`).

Edits run in the project's editor window (it opens when needed): they show at once, each request
is one undo step labelled "Assistant: …", and autosave saves them. Reads and dry runs never open a
window. Exports go to the exports folder. The tools: `list_projects`, `get_project`, `cut_range`,
`trim_ends`, `split_at`, `delete_clips`, `trim_clip`, `move_clip`, `set_track`, `set_face_layout`,
`set_face_mode`, `set_face_keyframe`, `set_screen_crop`, `set_background`, `zoom_screen`,
`set_zoom_keyframe`, `auto_zoom`, `set_cursor_effects`, `add_annotation`, `edit_annotation`,
`remove_annotations`, `set_speed`, `freeze_frame`, `set_transition`, `set_marker`,
`remove_marker`, `set_clip_audio`, `set_volume_keyframe`, `set_audio_cleanup`, `nudge_sync`,
`set_marks`, `apply_edits` (several as one step), `find_silences`, `remove_silences`, `undo`,
`redo`, `get_frame`, `export_project`, `export_status`, `cancel_export`. Cursor effects and
`auto_zoom` need a recording with a cursor track. Captions, transcripts and adding media are not
editor features yet, so assistants cannot do them either.

## Packaging (Linux)

`npm run package:linux` writes `dist/capture-studio-<version>-x86_64.AppImage` and
`dist/capture-studio_<version>_amd64.deb`; `npm run smoke:linux` verifies them. Both ship FFmpeg and
ffprobe in `resources/bin/linux-x64/` with their licence, build info and source offer.

- The app id is `org.capturestudio.CaptureStudio` (`desktopName` in `package.json`). Electron uses
  it as the Wayland `app_id` and the X11 `WM_CLASS`, and the `.desktop` file has the same name and
  `StartupWMClass`, so GNOME groups windows under the launcher and portals see a stable id.
- The deb installs to `/opt/Capture Studio/` with a `/usr/bin/capture-studio` link.
- The AppImage uses the static type2 runtime, so it needs `fusermount3` but not `libfuse2`.

## Layout

- `src/main` — main process (lifecycle, windows, security, settings and secrets, FFmpeg location)
- `src/preload` — sandboxed preload scripts
- `src/renderer` — UI windows and their workers (no Node)
- `src/utility/media` — the media utility process (FFmpeg runner, probe)
- `src/shared` — pure TypeScript shared by every process (time, IDs, project schema, naming)
- `src/mcp` — the MCP server for assistants; reaches the app only through its automation socket
- `scripts` — FFmpeg fetcher and manifest, JSON Schema and icon generators, package smoke test
- `build` — packaging resources (app icons)
- `tests` — `unit`, `integration` (real FFmpeg), `e2e` (Playwright)

FFmpeg licensing: the bundled GPL build ships with its licence text and a source offer
(`resources/licenses/`).
