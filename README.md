# Capture Studio

Screen recorder with a teaching-focused video editor, built on Electron and TypeScript.
Licensed under GPL-3.0-or-later (see `LICENSE`).

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
| `npm run package:linux` | AppImage and deb in `dist/`                                          |

Environment switches:

- `CS_FORCE_X11=1` runs under XWayland instead of native Wayland.
- `CS_USER_DATA_DIR=<dir>` uses a separate profile (settings, logs, single-instance lock);
  development builds only.
- `CS_FFMPEG_DIR=<dir>` uses FFmpeg binaries from another folder; development builds only.

## Layout

- `src/main` — main process (lifecycle, windows, security, settings and secrets, FFmpeg location)
- `src/preload` — sandboxed preload scripts
- `src/renderer` — UI windows and their workers (no Node)
- `src/utility/media` — the media utility process (FFmpeg runner, probe)
- `src/shared` — pure TypeScript shared by every process (time, IDs, project schema, naming)
- `scripts` — FFmpeg fetcher and manifest, JSON Schema generator
- `tests` — `unit`, `integration` (real FFmpeg), `e2e` (Playwright)

FFmpeg licensing: the bundled GPL build ships with its licence text and a source offer
(`resources/licenses/`).
