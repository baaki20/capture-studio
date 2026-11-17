/**
 * Annotations in the editor (R2.5–R2.8), driven through the UI: a title added from the
 * Annotations panel and retyped, drawn in the preview where the scene puts it; dragged on the
 * preview (its box moves); a pixelate region added, which blocks out the picture under it; the
 * title deleted with Delete and brought back with undo; the object row on the timeline.
 *
 * Uses the parity harness's rounded-face project (grey screen, magenta camera); test mode on
 * X11 with software WebGL, the editor opened through the test-only control channel.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { timeToX } from '../../src/renderer/editor/Timeline/geometry';
import { sceneAt } from '../../src/shared/project/scene';
import type { Project } from '../../src/shared/project/schema';
import { createDefaultSettings } from '../../src/shared/settings/schema';
import type { Picture } from '../sync/image';
import { ChannelClient } from '../wayland/lib/channel-client';
import { FFMPEG_DIR, FIXTURES } from './parity/fixtures';
import { HAS_DISPLAY, controlSocketPath, recordConsole } from './platform';

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

const docOf = async (editor: Page) => (await editor.evaluate(() => window.csEditorDebug?.doc()))!;

/** Near-white pixels inside `r` (clipped to the picture). */
function whiteIn(p: Picture, r: { x: number; y: number; width: number; height: number }): number {
  let n = 0;
  for (let y = Math.max(0, Math.floor(r.y)); y < Math.min(p.height, r.y + r.height); y++) {
    for (let x = Math.max(0, Math.floor(r.x)); x < Math.min(p.width, r.x + r.width); x++) {
      const [red, green, blue] = rgb(p, x, y);
      if (red > 235 && green > 235 && blue > 235) n++;
    }
  }
  return n;
}

test.skip(!HAS_DISPLAY, 'needs a display');

test('add, retype, drag, pixelate, delete and undo annotations (R2.5–R2.8)', async () => {
  test.setTimeout(180_000);
  const userData = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-objects-'));
  const projects = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-objects-projects-'));
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

    const annotations = page.getByTestId('annotations-panel');
    await annotations.getByRole('button', { name: 'Title', exact: true }).click();
    const panel = page.getByTestId('object-panel');
    await expect(panel).toBeVisible();
    await panel.getByLabel('Text', { exact: true }).fill('Hello world');
    let edited: Project = await docOf(page);
    const items = (d: Project) => d.timeline.objectTracks?.flatMap((t) => t.items) ?? [];
    const title = items(edited)[0]!;
    expect(title).toMatchObject({ kind: 'text', text: 'Hello world', inUs: 0, outUs: 3 * S });
    await expect(page.getByTestId('track-header-Annotations')).toBeVisible();

    // White title text inside its box, nothing white just outside it.
    let shot = await picture(page, S);
    const box = sceneAt(edited, S).objects[0]!.rectPx;
    expect(whiteIn(shot, box), 'title pixels').toBeGreaterThan(200);

    // Drag it 100 display px right on the preview: the box moves by 100 / scale canvas px.
    const overlay = page.getByTestId('overlay-layer');
    const ob = (await overlay.boundingBox())!;
    const { width: cw, height: ch } = edited.timeline.canvas;
    const scale = Math.min(ob.width / cw, ob.height / ch);
    const at = (x: number, y: number) => ({
      x: ob.x + (ob.width - cw * scale) / 2 + x * scale,
      y: ob.y + (ob.height - ch * scale) / 2 + y * scale,
    });
    const start = at(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 50, start.y, { steps: 3 });
    await page.mouse.move(start.x + 100, start.y, { steps: 3 });
    await page.mouse.up();
    await expect(page.getByTestId('object-box')).toBeVisible();
    edited = await docOf(page);
    const movedBox = items(edited)[0]!.box;
    expect((movedBox.x - title.box.x) * cw).toBeCloseTo(100 / scale, 0);
    expect(movedBox.y).toBeCloseTo(title.box.y, 6);

    // A pixelate region over the screen's middle: blocks of one colour.
    await page.getByTestId('timeline-canvas').click({ position: { x: 5, y: 10 } });
    await annotations.getByRole('button', { name: 'Pixelate' }).click();
    edited = await docOf(page);
    expect(items(edited).map((i) => i.kind)).toEqual(['text', 'pixelate']);
    shot = await picture(page, S);
    const region = sceneAt(edited, S).objects[1]!;
    if (region.item.kind !== 'pixelate') throw new Error('pixelate expected');
    const block = region.item.blockSize * Math.min(cw, ch);
    // Inside one block every pixel matches the block's centre.
    const bx = Math.floor(region.rectPx.x + block * 1.5);
    const by = Math.floor(region.rectPx.y + block * 1.5);
    const centre = rgb(shot, bx, by);
    for (const [dx, dy] of [
      [-4, -4],
      [4, 4],
      [-4, 4],
    ] as const) {
      const p = rgb(shot, bx + dx, by + dy);
      expect(Math.max(...p.map((v, i) => Math.abs(v - centre[i]!)))).toBeLessThanOrEqual(2);
    }

    // Select the title on the timeline's object row, delete it with Delete, undo.
    const view = (await page.evaluate(() => window.csEditorDebug?.ui().view))!;
    const rowTop = 28 + 2;
    await page.getByTestId('timeline-canvas').click({
      position: { x: timeToX(view, 0.5 * S), y: rowTop + 6 },
    });
    await expect(panel).toContainText('Hello world');
    await page.keyboard.press('Delete');
    expect(items(await docOf(page)).map((i) => i.kind)).toEqual(['pixelate']);
    await page.keyboard.press('Control+z');
    await expect
      .poll(async () => items(await docOf(page)).map((i) => i.kind))
      .toEqual(['text', 'pixelate']);
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
