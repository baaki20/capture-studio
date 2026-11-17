/**
 * Time edits in the editor (R2.10, R2.18–R2.20), driven through the UI: 2× over the In–Out marks
 * from the Speed and time panel (every track, and the preview's pitch-kept audio render written to
 * the project cache), a freeze frame at the playhead, a dissolve on the selected screen clip from
 * the Transition panel, and a chapter marker added with M and titled in the Markers panel.
 *
 * Builds its own project (screen, camera and a microphone tone); test mode on X11 with software
 * WebGL, the editor opened through the test-only control channel.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { layoutRows, timeToX } from '../../src/renderer/editor/Timeline/geometry';
import type { Project } from '../../src/shared/project/schema';
import { clipEndUs } from '../../src/shared/project/timeline-ops';
import { createDefaultSettings } from '../../src/shared/settings/schema';
import { recordedProject, trackByName } from '../fixtures/editor-project';
import { ChannelClient } from '../wayland/lib/channel-client';
import { FFMPEG_DIR, FPS, ff } from './parity/fixtures';
import { HAS_DISPLAY } from './platform';

const ROOT = path.join(import.meta.dirname, '../..');
const MAIN = path.join(ROOT, 'out/main/index.js');
const S = 1_000_000;
const SECONDS = 8;

const docOf = async (editor: Page) => (await editor.evaluate(() => window.csEditorDebug?.doc()))!;

/** Moves the playhead to `seconds` with Home and frame steps. */
async function goTo(editor: Page, seconds: number) {
  await editor.keyboard.press('Home');
  for (let i = 0; i < Math.round(seconds * FPS); i++) {
    await editor.keyboard.press('ArrowRight', { delay: 0 });
  }
  await expect
    .poll(() => editor.evaluate(() => window.csEditorDebug?.ui().playheadUs))
    .toBe(Math.round(seconds * S));
}

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
    id: 'prj_01JBQ4ZJ4X6V3K8N2M7P5R9TTE',
    name: 'Time edits',
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

test('speed with its audio render, freeze frame, dissolve and a chapter marker', async () => {
  test.setTimeout(180_000);
  const userData = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-time-'));
  const projects = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-time-projects-'));
  mkdirSync(path.join(projects, 'Exports'), { recursive: true });
  writeFileSync(
    path.join(userData, 'settings.json'),
    JSON.stringify(
      createDefaultSettings({ projectsDir: projects, exportsDir: path.join(projects, 'Exports') }),
    ),
  );
  const { root, doc } = buildProject(projects);
  const socket = path.join(userData, 'control.sock');
  const app = await electron.launch({
    args: [
      '--ozone-platform=x11',
      '--enable-unsafe-swiftshader',
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

    // 2× from 2 s to 4 s on every track.
    await page.getByTestId('timeline-canvas').click({ position: { x: 5, y: 10 } });
    await goTo(page, 2);
    await page.keyboard.press('i');
    await goTo(page, 4);
    await page.keyboard.press('o');
    const speed = page.getByTestId('speed-panel');
    await expect(speed).toContainText('In–Out');
    await speed.getByLabel('Speed').selectOption('2');
    let edited = await docOf(page);
    for (const name of ['Screen', 'Face', 'Voice']) {
      expect(
        trackByName(edited, name).clips.map((c) => [c.timelineStartUs / S, clipEndUs(c) / S]),
      ).toEqual([
        [0, 2],
        [2, 3],
        [3, 7],
      ]);
    }
    // The preview's audio for the sped-up part is rendered into the project cache.
    const renders = path.join(root, 'cache', 'audio');
    await expect
      .poll(
        () => (existsSync(renders) ? readdirSync(renders).filter((f) => f.endsWith('.wav')) : []),
        {
          timeout: 20_000,
        },
      )
      .toHaveLength(1);

    // A 1 s freeze frame at 5 s.
    await page.keyboard.press('Alt+x');
    await goTo(page, 5);
    await speed.getByLabel('Freeze length').selectOption(String(S));
    await speed.getByRole('button', { name: 'Freeze frame at playhead' }).click();
    edited = await docOf(page);
    expect(
      trackByName(edited, 'Screen').clips.some((c) => c.freeze && c.timelineStartUs === 5 * S),
    ).toBe(true);

    // Select the screen clip that starts at 3 s and give it a dissolve.
    const view = (await page.evaluate(() => window.csEditorDebug?.ui().view))!;
    const row = layoutRows(edited).rows.find((r) => r.track.name === 'Screen')!;
    await page.getByTestId('timeline-canvas').click({
      position: { x: timeToX(view, 3.5 * S), y: row.top + 10 },
    });
    const transition = page.getByTestId('transition-panel');
    await transition.getByLabel('Kind').selectOption('dissolve');
    edited = await docOf(page);
    const target = trackByName(edited, 'Screen').clips.find((c) => c.timelineStartUs === 3 * S);
    expect(target?.transitionIn).toEqual({ kind: 'dissolve', durationUs: 500_000 });

    // A chapter marker at 1 s with M, titled in the Markers panel.
    await page.getByTestId('timeline-canvas').click({ position: { x: 5, y: 10 } });
    await goTo(page, 1);
    await page.keyboard.press('m');
    const markers = page.getByTestId('markers-panel');
    await expect(markers.getByRole('listitem')).toHaveCount(1);
    await markers.getByLabel(/Label of the marker/).fill('Intro');
    await markers.getByLabel('Chapter').check();
    edited = await docOf(page);
    expect(edited.timeline.markers).toEqual([
      expect.objectContaining({ tUs: S, label: 'Intro', chapter: true }),
    ]);
    expect(errors).toEqual([]);
  } finally {
    channel.close();
    await app.close().catch(() => undefined);
    rmSync(userData, { recursive: true, force: true });
    rmSync(projects, { recursive: true, force: true });
  }
});
