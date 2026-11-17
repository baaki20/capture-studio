/**
 * Screen background and zoom in the editor (R2.9, R2.11), driven through the UI: the Background
 * panel (styled background, a preset swatch), a 2× zoom over the In–Out marks from the Zoom and
 * pan panel, a zoom keyframe selected on the screen row's lane and deleted with Delete, then
 * undone. The preview is checked by pixel: the gradient fills the padding, the zoomed screen
 * covers it, and the magenta face stays where the scene puts it (the camera does not move it).
 *
 * Uses the parity harness's rounded-face project (grey screen, magenta camera); test mode on
 * X11 with software WebGL, the editor opened through the test-only control channel.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { layoutRows, timeToX, KEYFRAME_LANE_PX } from '../../src/renderer/editor/Timeline/geometry';
import { sceneAt } from '../../src/shared/project/scene';
import type { Project } from '../../src/shared/project/schema';
import { createDefaultSettings } from '../../src/shared/settings/schema';
import { keyedBox, type Picture } from '../sync/image';
import { ChannelClient } from '../wayland/lib/channel-client';
import { FFMPEG_DIR, FIXTURES, FPS, magenta } from './parity/fixtures';
import { HAS_DISPLAY, controlSocketPath, SOFTWARE_GL_ARGS } from './platform';

const ROOT = path.join(import.meta.dirname, '../..');
const MAIN = path.join(ROOT, 'out/main/index.js');
const S = 1_000_000;

async function picture(editor: Page, tUs: number): Promise<Picture> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const shot = await editor.evaluate((t) => window.csEditorDebug?.capturePreview(t) ?? null, tUs);
    if (shot?.exact) {
      return {
        width: shot.width,
        height: shot.height,
        data: Buffer.from(shot.rgbaBase64, 'base64'),
        channels: 4,
      };
    }
    await editor.waitForTimeout(100);
  }
  throw new Error(`the preview never showed the exact frame at ${String(tUs)} µs`);
}

/** RGB of a picture's pixel. */
function rgb(p: Picture, x: number, y: number): [number, number, number] {
  const i = (y * p.width + x) * p.channels;
  return [p.data[i] ?? 0, p.data[i + 1] ?? 0, p.data[i + 2] ?? 0];
}

const saturation = ([r, g, b]: [number, number, number]) => Math.max(r, g, b) - Math.min(r, g, b);

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

test.skip(!HAS_DISPLAY, 'needs a display');

test('background style, a zoomed range, zoom keyframe delete and undo (R2.9, R2.11)', async () => {
  test.setTimeout(180_000);
  const userData = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-screen-'));
  const projects = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-screen-projects-'));
  mkdirSync(path.join(projects, 'Exports'), { recursive: true });
  writeFileSync(
    path.join(userData, 'settings.json'),
    JSON.stringify(
      createDefaultSettings({ projectsDir: projects, exportsDir: path.join(projects, 'Exports') }),
    ),
  );
  const fixture = FIXTURES.find((f) => f.name === 'p1-rounded-face');
  if (!fixture) throw new Error('no rounded-face fixture');
  const { doc } = fixture.build(projects);
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

    // A styled background, then the teal preset: the padding shows the gradient.
    const background = page.getByTestId('background-panel');
    await background.getByLabel('Styled').check();
    await background.getByRole('button', { name: 'Teal to blue' }).click();
    let edited: Project = await docOf(page);
    expect(edited.timeline.beautify?.background).toEqual({
      type: 'gradient',
      from: '#0D9488',
      to: '#1D4ED8',
      angleDeg: 135,
    });
    let shot = await picture(page, S);
    expect(saturation(rgb(shot, 4, 4)), 'gradient in the padding').toBeGreaterThan(60);
    const screen = sceneAt(edited, S).layers.find((l) => l.kind !== 'overlay')!.destRect;
    expect(screen.x).toBeGreaterThan(20);
    expect(saturation(rgb(shot, screen.x + 40, screen.y + 40)), 'grey screen').toBeLessThan(24);

    // 2× zoom from 2 s to 4 s with the default 0.6 s change.
    await page.getByTestId('timeline-canvas').click({ position: { x: 5, y: 10 } });
    await goTo(page, 2);
    await page.keyboard.press('i');
    await goTo(page, 4);
    await page.keyboard.press('o');
    const zoomPanel = page.getByTestId('camera-panel');
    await expect(zoomPanel).toContainText('Zoom In–Out');
    await zoomPanel.getByRole('button', { name: '2×' }).click();
    edited = await docOf(page);
    expect(edited.timeline.camera?.map((k) => [k.tUs, k.rect.width])).toEqual([
      [1.4 * S, 1],
      [2 * S, 0.5],
      [3.4 * S, 0.5],
      [4 * S, 1],
    ]);
    await expect(page.getByTestId('camera-keyframe-list').getByRole('listitem')).toHaveCount(4);

    // Zoomed at 3 s: the screen covers the padding; the face is where the scene puts it.
    shot = await picture(page, 3 * S);
    expect(saturation(rgb(shot, 4, 4)), 'zoomed screen over the padding').toBeLessThan(24);
    const face = sceneAt(edited, 3 * S).layers.find((l) => l.kind === 'overlay')!.destRect;
    const box = keyedBox(shot, magenta);
    expect(box).not.toBeNull();
    expect(Math.abs(box!.x - face.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(box!.width - face.width)).toBeLessThanOrEqual(2);

    // Select the 4 s zoom keyframe on the screen row's lane, delete it, undo.
    const view = (await page.evaluate(() => window.csEditorDebug?.ui().view))!;
    const row = layoutRows(edited).rows.find((r) => r.track.name === 'Screen')!;
    await page.getByTestId('timeline-canvas').click({
      position: { x: timeToX(view, 4 * S), y: row.top + row.height - KEYFRAME_LANE_PX / 2 },
    });
    await expect
      .poll(() => page.evaluate(() => window.csEditorDebug?.ui().selectedKeyframe ?? null))
      .toMatchObject({ lane: 'camera', tUs: 4 * S });
    await page.keyboard.press('Delete');
    expect((await docOf(page)).timeline.camera?.map((k) => k.tUs)).toEqual([
      1.4 * S,
      2 * S,
      3.4 * S,
    ]);
    await page.keyboard.press('Control+z');
    await expect
      .poll(async () => (await docOf(page)).timeline.camera?.map((k) => k.tUs))
      .toEqual([1.4 * S, 2 * S, 3.4 * S, 4 * S]);
    expect(errors).toEqual([]);
  } finally {
    channel.close();
    await app.close().catch(() => undefined);
    rmSync(userData, { recursive: true, force: true });
    rmSync(projects, { recursive: true, force: true });
  }
});
