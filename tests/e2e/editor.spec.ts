/**
 * Editor end to end (steps 16–18; R1.20, R1.26, R1.28, R1.31, R1.33–R1.43): record a short clip
 * with the fake camera and mic and the X11 screen capturer (never the GNOME portal; `CS_TEST=1`),
 * let the editor open, then check the preview draws a picture, split + delete + undo, move the
 * face to a corner, nudge, that autosave writes `project.json`, and that media files are never
 * modified by editing.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { createDefaultSettings } from '../../src/shared/settings/schema';

const ROOT = path.join(import.meta.dirname, '../..');
const MAIN = path.join(ROOT, 'out/main/index.js');
const FFMPEG_DIR = path.join(ROOT, 'resources/bin', `${process.platform}-${process.arch}`);

interface Launched {
  app: ElectronApplication;
  shell: Page;
  userData: string;
  projects: string;
  cleanup(): Promise<void>;
}

async function launch(): Promise<Launched> {
  const userData = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-editor-'));
  const projects = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-editor-projects-'));
  const settings = createDefaultSettings({
    projectsDir: projects,
    exportsDir: path.join(projects, 'Exports'),
  });
  settings.recorder = {
    ...settings.recorder,
    systemAudio: false,
    minimizeControlsOnStart: 'off',
    countdownSec: 0,
    afterRecording: 'open-editor',
  };
  writeFileSync(path.join(userData, 'settings.json'), JSON.stringify(settings));
  const app = await electron.launch({
    args: [
      '--ozone-platform=x11',
      // No GPU under Xvfb (CI): Chromium only falls back to software WebGL for the preview when asked.
      '--enable-unsafe-swiftshader',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--disable-features=WebRTCPipeWireCapturer',
      MAIN,
    ],
    cwd: ROOT,
    env: {
      ...process.env,
      CS_TEST: '1',
      CS_USER_DATA_DIR: userData,
      CS_FFMPEG_DIR: FFMPEG_DIR,
      XDG_SESSION_TYPE: 'x11',
      WAYLAND_DISPLAY: '',
    },
  });
  const shell = await app.firstWindow();
  return {
    app,
    shell,
    userData,
    projects,
    async cleanup() {
      await app.close().catch(() => undefined);
      await test
        .info()
        .attach('main.log', { path: path.join(userData, 'logs', 'main.log') })
        .catch(() => undefined);
      rmSync(userData, { recursive: true, force: true });
      rmSync(projects, { recursive: true, force: true });
    },
  };
}

async function windowFor(app: ElectronApplication, fragment: string, timeout = 60_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const page = app.windows().find((w) => w.url().includes(fragment));
    if (page) return page;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no ${fragment} window within ${String(timeout)} ms`);
}

async function recState(shell: Page): Promise<string> {
  return shell.evaluate(async () => (await window.captureStudio.rec.status()).state);
}

/** Records about 4 s with the fake camera and mic; returns the project folder. */
async function recordShortClip(run: Launched): Promise<string> {
  const { app, shell } = run;
  const camera = shell.getByTestId('camera-select');
  await expect(camera.locator('option')).not.toHaveCount(1);
  await camera.selectOption({ index: 1 });
  const mic = shell.getByTestId('mic-select');
  await expect(mic.locator('option')).not.toHaveCount(1);
  await mic.selectOption({ index: 1 });
  await shell.getByTestId('record-button').click();

  const end = Date.now() + 25_000;
  let state = await recState(shell);
  while (['configuring', 'acquiring'].includes(state) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 200));
    state = await recState(shell);
  }
  test.skip(state === 'acquiring', 'desktopCapturer gave no screen (X display without capture)');

  const controls = await windowFor(app, 'controls/index.html');
  await expect(controls.getByTestId('controls')).toBeVisible({ timeout: 15_000 });
  await expect(controls.getByTestId('elapsed')).not.toHaveText('00:00', { timeout: 10_000 });
  await controls.waitForTimeout(3_500);
  await controls.getByRole('button', { name: 'Stop' }).click();
  const folders = await expect
    .poll(() => readdirSync(run.projects).filter((n) => n.endsWith('.cstudio')), {
      timeout: 60_000,
    })
    .toHaveLength(1)
    .then(() => readdirSync(run.projects).filter((n) => n.endsWith('.cstudio')));
  return path.join(run.projects, folders[0]!);
}

interface DebugDoc {
  timeline: {
    canvas: { width: number; height: number };
    tracks: {
      name: string;
      clips: { id: string; timelineStartUs: number }[];
      layout?: { centerX: number; centerY: number };
    }[];
  };
  media: { id: string; role: string; syncAdjustUs: number; path: string }[];
}

const editorDoc = (editor: Page) =>
  editor.evaluate(() => window.csEditorDebug?.doc() ?? null) as Promise<DebugDoc | null>;

const clipCount = async (editor: Page, track: string) =>
  (await editorDoc(editor))?.timeline.tracks.find((t) => t.name === track)?.clips.length ?? 0;

function checksums(root: string): Record<string, string> {
  const dir = path.join(root, 'media');
  return Object.fromEntries(
    readdirSync(dir).map((name) => [
      name,
      createHash('sha256')
        .update(readFileSync(path.join(dir, name)))
        .digest('hex'),
    ]),
  );
}

test.skip(process.platform !== 'linux' || !process.env.DISPLAY, 'needs Linux with an X display');

test('record → editor opens → preview, split/delete/undo, face corner, nudge, autosave (R1.20, R1.26, R1.28, R1.31–R1.43)', async () => {
  test.setTimeout(240_000);
  const run = await launch();
  try {
    const root = await recordShortClip(run);

    // R1.20: the editor opens after the recording.
    const editor = await windowFor(run.app, 'editor/index.html');
    const errors: string[] = [];
    editor.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    await expect(editor.getByTestId('editor')).toBeVisible({ timeout: 30_000 });
    // Finalize is done once the editor opens; from here media must never change.
    const before = checksums(root);

    // R1.31: Screen, Face, Voice tracks; Face + Voice share one linked header group.
    await expect(editor.getByTestId('track-header-Screen')).toBeVisible();
    await expect(editor.getByTestId('track-header-Face')).toBeVisible();
    await expect(editor.getByTestId('track-header-Voice')).toBeVisible();
    await expect(editor.getByTestId('face-voice-group')).toContainText('linked');

    // R1.33: the preview decodes through cs-media:// (Range fetch from the worker) and draws a
    // picture that is not black (the fake camera is colourful).
    await expect
      .poll(
        async () => {
          const probe = await editor.evaluate(() => window.csEditorDebug?.probePreview(1_000_000));
          return probe?.exact ? probe.nonBlack : 0;
        },
        { timeout: 30_000, intervals: [250, 500, 1_000] },
      )
      .toBeGreaterThan(0.02);

    // R1.34: Space plays, the timecode advances, Space pauses.
    const timecode = editor.getByTestId('timecode');
    await editor.getByTestId('timeline-canvas').click({ position: { x: 5, y: 10 } });
    await editor.keyboard.press('Space');
    await expect(timecode).not.toHaveText('00:00:00:00', { timeout: 5_000 });
    await editor.keyboard.press('Space');
    await expect.poll(() => editor.evaluate(() => window.csEditorDebug?.ui().playing)).toBe(false);

    // R1.35: scrub to the middle of the timeline and split with S.
    const canvas = editor.getByTestId('timeline-canvas');
    const box = (await canvas.boundingBox())!;
    await editor.keyboard.press('Shift+Z'); // fit
    await canvas.click({ position: { x: box.width * 0.4, y: 10 } });
    const screenClips = await clipCount(editor, 'Screen');
    const faceClips = await clipCount(editor, 'Face');
    await editor.keyboard.press('s');
    await expect.poll(() => clipCount(editor, 'Screen')).toBe(screenClips + 1);
    expect(await clipCount(editor, 'Face')).toBe(faceClips + 1);
    expect(await clipCount(editor, 'Voice')).toBe(faceClips + 1);

    // R1.37: select the right-hand screen clip and delete it; R1.43: Ctrl+Z restores it.
    await canvas.click({ position: { x: box.width * 0.4 + 30, y: 28 + 2 + 28 } });
    await expect
      .poll(() => editor.evaluate(() => window.csEditorDebug?.ui().selection.length))
      .toBe(1);
    await editor.keyboard.press('Delete');
    await expect.poll(() => clipCount(editor, 'Screen')).toBe(screenClips);
    await editor.keyboard.press('Control+z');
    await expect.poll(() => clipCount(editor, 'Screen')).toBe(screenClips + 1);
    await editor.keyboard.press('Control+Shift+Z');
    await expect.poll(() => clipCount(editor, 'Screen')).toBe(screenClips);
    await editor.keyboard.press('Control+z');
    await expect.poll(() => clipCount(editor, 'Screen')).toBe(screenClips + 1);

    // R1.41: corner preset moves the face overlay to the top left.
    await editor.getByTestId('face-panel').getByRole('button', { name: 'Top left' }).click();
    await expect
      .poll(async () => {
        const face = (await editorDoc(editor))?.timeline.tracks.find((t) => t.name === 'Face');
        return face?.layout && face.layout.centerX < 0.5 && face.layout.centerY < 0.5;
      })
      .toBe(true);
    // Selecting the face in the preview shows its bounding box.
    const overlay = editor.getByTestId('overlay-layer');
    const ob = (await overlay.boundingBox())!;
    // Click the face's centre: the canvas is shown with "contain" inside the overlay layer.
    const placed = (await editorDoc(editor))!;
    const faceLayout = placed.timeline.tracks.find((t) => t.name === 'Face')!.layout!;
    const { width: cw, height: ch } = placed.timeline.canvas;
    const scale = Math.min(ob.width / cw, ob.height / ch);
    await overlay.click({
      position: {
        x: (ob.width - cw * scale) / 2 + faceLayout.centerX * cw * scale,
        y: (ob.height - ch * scale) / 2 + faceLayout.centerY * ch * scale,
      },
    });
    await expect(editor.getByTestId('face-box')).toBeVisible();

    // R1.42: nudge Face + Voice by +120 ms; clips do not move.
    const startsBefore = (await editorDoc(editor))!.timeline.tracks.map((t) =>
      t.clips.map((c) => c.timelineStartUs),
    );
    const field = editor.getByLabel('Face + Voice offset (ms)');
    await field.fill('120');
    await field.blur();
    await expect
      .poll(async () =>
        (await editorDoc(editor))?.media
          .filter((m) => m.role === 'camera' || m.role === 'microphone')
          .map((m) => m.syncAdjustUs),
      )
      .toEqual([120_000, 120_000]);
    expect(
      (await editorDoc(editor))!.timeline.tracks.map((t) => t.clips.map((c) => c.timelineStartUs)),
    ).toEqual(startsBefore);

    // R1.28: autosave writes project.json within 2 s (allow scheduling slack).
    await expect
      .poll(
        () => {
          const saved = JSON.parse(
            readFileSync(path.join(root, 'project.json'), 'utf8'),
          ) as DebugDoc;
          return saved.media.filter((m) => m.role === 'camera').map((m) => m.syncAdjustUs);
        },
        { timeout: 6_000 },
      )
      .toEqual([120_000]);
    await expect(editor.getByTestId('save-status')).toHaveText('Saved');
    const saved = JSON.parse(readFileSync(path.join(root, 'project.json'), 'utf8')) as DebugDoc;
    expect(saved.timeline.tracks.find((t) => t.name === 'Screen')?.clips).toHaveLength(
      screenClips + 1,
    );

    // R1.26: editing never touched the media files.
    expect(checksums(root)).toEqual(before);
    expect(errors.filter((e) => !e.includes('DevTools'))).toEqual([]);

    // Closing the editor flushes autosave first; Library → Open opens it again.
    await run.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().includes('editor/index.html'))
        ?.close(),
    );
    await expect.poll(() => run.app.windows().some((w) => w.url().includes('editor/'))).toBe(false);
    await run.shell.getByRole('button', { name: 'Library', exact: true }).click();
    await run.shell.getByRole('button', { name: 'Open', exact: true }).first().click();
    const reopened = await windowFor(run.app, 'editor/index.html');
    await expect(reopened.getByTestId('editor')).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(
        async () =>
          (await editorDoc(reopened))?.media.find((m) => m.role === 'camera')?.syncAdjustUs,
      )
      .toBe(120_000);
  } finally {
    await run.cleanup();
  }
});
