/**
 * Audio in the editor (R2.14, R2.17), driven through the UI: "Find pauses" proposes the 2 s pause
 * in the voice, the user cuts it (every track, one undo step) and undoes it; strong noise
 * reduction on the voice writes its cleaned audio into the project cache for the preview.
 *
 * Builds its own project (screen, camera, and a microphone tone with a pause from 2 s to 4 s);
 * test mode on X11 with software WebGL, the editor opened through the test-only control channel.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import type { Project } from '../../src/shared/project/schema';
import { clipEndUs } from '../../src/shared/project/timeline-ops';
import { createDefaultSettings } from '../../src/shared/settings/schema';
import { recordedProject, trackByName } from '../fixtures/editor-project';
import { ChannelClient } from '../wayland/lib/channel-client';
import { FFMPEG_DIR, FPS, ff } from './parity/fixtures';
import { HAS_DISPLAY, controlSocketPath, SOFTWARE_GL_ARGS, recordConsole } from './platform';

const ROOT = path.join(import.meta.dirname, '../..');
const MAIN = path.join(ROOT, 'out/main/index.js');
const S = 1_000_000;
const SECONDS = 8;

const docOf = async (editor: Page) => (await editor.evaluate(() => window.csEditorDebug?.doc()))!;

/** A project folder with a screen, a camera and a 440 Hz microphone. */
function buildProject(projectsDir: string): { root: string; doc: Project } {
  const doc: Project = {
    ...recordedProject({
      durationUs: SECONDS * S,
      pauses: [],
      system: false,
      screenSize: { width: 1280, height: 720 },
      cameraSize: { width: 640, height: 480 },
      offsets: { screen: 0, camera: 0, microphone: 0 },
    }),
    id: 'prj_01JBQ4ZJ4X6V3K8N2M7P5R9TAU',
    name: 'Audio edits',
  };
  for (const m of doc.media) m.clockRatio = 1;
  const root = path.join(projectsDir, `${doc.name}.cstudio`);
  const media = path.join(root, 'media');
  mkdirSync(media, { recursive: true });
  const d = String(SECONDS);
  ff([
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=1280x720:rate=${String(FPS)}:duration=${d}`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-g',
    '30',
    '-pix_fmt',
    'yuv420p',
    path.join(media, 'screen.mp4'),
  ]);
  ff([
    '-f',
    'lavfi',
    '-i',
    `color=c=0xFF00FF:s=640x480:r=${String(FPS)}:d=${d}`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    path.join(media, 'camera.mp4'),
  ]);
  ff([
    '-f',
    'lavfi',
    '-i',
    `sine=f=440:r=48000:d=${d}`,
    '-af',
    "volume=enable='between(t,2,4)':volume=0",
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    path.join(media, 'microphone.mp4'),
  ]);
  writeFileSync(path.join(root, 'project.json'), JSON.stringify(doc, null, 2));
  return { root, doc };
}

test.skip(!HAS_DISPLAY, 'needs a display');

test('find and cut a pause with undo, and noise reduction into the cache', async () => {
  test.setTimeout(180_000);
  const userData = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-audio-'));
  const projects = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-audio-projects-'));
  mkdirSync(path.join(projects, 'Exports'), { recursive: true });
  writeFileSync(
    path.join(userData, 'settings.json'),
    JSON.stringify(
      createDefaultSettings({ projectsDir: projects, exportsDir: path.join(projects, 'Exports') }),
    ),
  );
  const { root, doc } = buildProject(projects);
  const socket = controlSocketPath(userData);
  const app = await electron.launch({
    args: [
      '--ozone-platform=x11',
      ...SOFTWARE_GL_ARGS,
      '--disable-features=WebRTCPipeWireCapturer',
      MAIN,
    ],
    cwd: ROOT,
    env: {
      ...process.env,
      CS_TEST: '1',
      CS_USER_DATA_DIR: userData,
      CS_FFMPEG_DIR: FFMPEG_DIR,
      CS_HARNESS_SOCKET: socket,
      XDG_SESSION_TYPE: 'x11',
      WAYLAND_DISPLAY: '',
    },
  });
  const consoleLog = recordConsole(app);
  const channel = await ChannelClient.connect(socket);
  try {
    await app.firstWindow();
    await channel.call('editor.open', { projectId: doc.id });
    let editor: Page | undefined;
    await expect
      .poll(() => (editor = app.windows().find((w) => w.url().includes('editor/index.html'))), {
        timeout: 20_000,
      })
      .toBeTruthy();
    if (!editor) return;
    const page = editor;
    await expect
      .poll(() => page.evaluate(() => window.csEditorDebug?.doc()?.id ?? null), { timeout: 20_000 })
      .toBe(doc.id);
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    // Find pauses (the waveforms may still be loading: ask again until the list shows).
    const pauses = page.getByTestId('pauses-panel');
    await expect
      .poll(
        async () => {
          await pauses.getByRole('button', { name: 'Find pauses' }).click();
          return pauses.getByTestId('pause-list').getByRole('listitem').count();
        },
        { timeout: 30_000 },
      )
      .toBe(1);
    await pauses.getByRole('button', { name: /^Cut 1 pauses/ }).click();
    let edited = await docOf(page);
    // The pause, less the padding kept around speech, is gone from every track.
    const end = Math.max(...edited.timeline.tracks.flatMap((t) => t.clips.map(clipEndUs)));
    expect(end).toBeLessThan(SECONDS * S - 1.5 * S);
    expect(end).toBeGreaterThan(SECONDS * S - 2 * S);
    await page.getByTestId('timeline-canvas').click({ position: { x: 5, y: 10 } });
    await page.keyboard.press('Control+z');
    await expect
      .poll(async () =>
        Math.max(...(await docOf(page)).timeline.tracks.flatMap((t) => t.clips.map(clipEndUs))),
      )
      .toBe(SECONDS * S);

    // Strong noise reduction on the voice: the cleaned audio lands in the cache.
    const voiceAudio = page.getByTestId('audio-track-Voice');
    await voiceAudio.getByRole('radio', { name: 'Strong' }).click();
    edited = await docOf(page);
    const voiceTrack = trackByName(edited, 'Voice');
    expect(voiceTrack.type === 'audio' && voiceTrack.cleanup?.noise).toBe('strong');
    const cache = path.join(root, 'cache', 'audio');
    await expect
      .poll(
        () =>
          existsSync(cache) ? readdirSync(cache).filter((f) => f.endsWith('clean-strong.wav')) : [],
        { timeout: 30_000 },
      )
      .toHaveLength(1);
    expect(errors).toEqual([]);
  } finally {
    channel.close();
    await consoleLog.attach();
    await test
      .info()
      .attach('main.log', { path: path.join(userData, 'logs', 'main.log') })
      .catch(() => undefined);
    await app.close().catch(() => undefined);
    rmSync(userData, { recursive: true, force: true });
    rmSync(projects, { recursive: true, force: true });
  }
});
