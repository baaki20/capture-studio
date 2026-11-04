/**
 * Face layout over time in the editor (R2.1–R2.4), driven through the UI: In/Out marks with the
 * keyboard, "Side by side" in the inspector's Layout over time panel (a per-segment layout), the
 * keyframe list, deleting a keyframe and undoing it, and the border from the Border and shadow
 * panel. The preview is checked by colour key: the magenta face lands where the scene puts it.
 *
 * Uses the parity harness's rounded-face project (grey screen, magenta camera); test mode on
 * X11 with software WebGL, the editor opened through the test-only control channel.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { sceneAt } from '../../src/shared/project/scene';
import type { Project, VideoTrack } from '../../src/shared/project/schema';
import { createDefaultSettings } from '../../src/shared/settings/schema';
import { keyedBox, type Picture } from '../sync/image';
import { ChannelClient } from '../wayland/lib/channel-client';
import { FFMPEG_DIR, FIXTURES, FPS, magenta } from './parity/fixtures';

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

const docOf = async (editor: Page) => (await editor.evaluate(() => window.csEditorDebug?.doc()))!;

function face(doc: Project): VideoTrack {
  const track = doc.timeline.tracks.find((t) => t.name === 'Face');
  if (track?.type !== 'video') throw new Error('no face track');
  return track;
}

/** Moves the playhead to `seconds` with Home and frame steps. */
async function goTo(editor: Page, seconds: number) {
  await editor.keyboard.press('Home');
  await editor.keyboard.press('ArrowRight', { delay: 0 });
  for (let i = 1; i < Math.round(seconds * FPS); i++) {
    await editor.keyboard.press('ArrowRight', { delay: 0 });
  }
  await expect
    .poll(() => editor.evaluate(() => window.csEditorDebug?.ui().playheadUs))
    .toBe(Math.round(seconds * S));
}

test.skip(process.platform !== 'linux' || !process.env.DISPLAY, 'needs Linux with an X display');

test('face mode for a section, keyframe list, delete and undo, border (R2.1–R2.4)', async () => {
  test.setTimeout(180_000);
  const userData = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-face-'));
  const projects = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-face-projects-'));
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
    const panel = page.getByTestId('face-time-panel');
    await expect(panel).toContainText('No keyframes');

    // Section 2 s–4 s, side by side, with the default 0.3 s change.
    await page.getByTestId('timeline-canvas').click({ position: { x: 5, y: 10 } });
    await goTo(page, 2);
    await page.keyboard.press('i');
    await goTo(page, 4);
    await page.keyboard.press('o');
    await expect(panel).toContainText('Face mode for In–Out');
    await panel.getByRole('button', { name: 'Side by side' }).click();

    let edited = await docOf(page);
    const keys = face(edited).layoutKeyframes ?? [];
    expect(keys.map((k) => [k.tUs, k.mode])).toEqual([
      [1.7 * S, 'overlay'],
      [2 * S, 'side-by-side'],
      [3.7 * S, 'side-by-side'],
      [4 * S, 'overlay'],
    ]);
    await expect(page.getByTestId('keyframe-list').getByRole('listitem')).toHaveCount(4);

    // The preview shows the face in the right half at 3 s, and back in its corner at 5 s.
    for (const [t, where] of [
      [3 * S, 'right half'],
      [5 * S, 'overlay'],
    ] as const) {
      const shot = await picture(page, t);
      const layer = sceneAt(edited, t).layers.find((l) => l.trackId === face(edited).id)!;
      const box = keyedBox(shot, magenta);
      expect(box, `face at ${where}`).not.toBeNull();
      expect(Math.abs(box!.x - layer.destRect.x)).toBeLessThanOrEqual(2);
      expect(Math.abs(box!.width - layer.destRect.width)).toBeLessThanOrEqual(2);
      if (where === 'right half') expect(layer.destRect.x).toBe(640);
    }

    // Delete the keyframe at 2 s from the list, then undo (with the playhead moved to 0 by the
    // ruler click: the 5 s picture below must be decoded again although its decode run is still
    // current, a case the preview once never finished).
    await page
      .getByTestId('keyframe-list')
      .getByRole('button', { name: /Delete keyframe at 00:00:02/ })
      .click();
    expect((face(await docOf(page)).layoutKeyframes ?? []).some((k) => k.tUs === 2 * S)).toBe(
      false,
    );
    await page.getByTestId('timeline-canvas').click({ position: { x: 5, y: 10 } });
    await page.keyboard.press('Control+z');
    await expect
      .poll(async () => (face(await docOf(page)).layoutKeyframes ?? []).map((k) => k.tUs))
      .toContain(2 * S);

    console.info('DEBUG after undo ok');
    // A white border on the face (whole track): white along the inside of the face box at 5 s.
    await page.getByTestId('face-style-panel').getByLabel('Border', { exact: true }).check();
    edited = await docOf(page);
    expect(face(edited).layout).toMatchObject({ border: { color: '#FFFFFF' } });
    const shot = await picture(page, 5 * S);
    const rect = sceneAt(edited, 5 * S).layers.find((l) => l.trackId === face(edited).id)!.destRect;
    const white = keyedBox(shot, (r, g, b) => r > 220 && g > 220 && b > 220, rect);
    expect(white).not.toBeNull();
    expect(Math.abs(white!.width - rect.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(white!.height - rect.height)).toBeLessThanOrEqual(2);
    expect(errors).toEqual([]);
  } finally {
    channel.close();
    await app.close().catch(() => undefined);
    rmSync(userData, { recursive: true, force: true });
    rmSync(projects, { recursive: true, force: true });
  }
});
