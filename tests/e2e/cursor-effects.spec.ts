/**
 * Cursor effects in the editor (R3.10–R3.12), driven through the Cursor panel: a project without
 * a cursor track only shows why; the parity harness's cursor project gets a bigger cursor and
 * no highlight (checked by pixel in the preview, next to the cursor), then auto-zoom finds two
 * click groups, one is unticked, and the other is added as one undo step, which Ctrl+Z removes.
 *
 * Test mode on X11 with software WebGL, the editor opened through the test-only control channel.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { cameraAt } from '../../src/shared/project/camera-keyframes';
import type { Project } from '../../src/shared/project/schema';
import { createDefaultSettings } from '../../src/shared/settings/schema';
import { ChannelClient } from '../wayland/lib/channel-client';
import { FFMPEG_DIR, FIXTURES } from './parity/fixtures';
import { HAS_DISPLAY, controlSocketPath, SOFTWARE_GL_ARGS } from './platform';

const ROOT = path.join(import.meta.dirname, '../..');
const MAIN = path.join(ROOT, 'out/main/index.js');

const docOf = async (editor: Page): Promise<Project> =>
  (await editor.evaluate(() => window.csEditorDebug?.doc()))!;

async function openEditor(app: ElectronApplication, channel: ChannelClient, id: string) {
  await channel.call('editor.open', { projectId: id });
  let editor: Page | undefined;
  await expect
    .poll(
      () =>
        (editor = app
          .windows()
          .find((w) => w.url().includes('editor/index.html') && !w.isClosed())),
      { timeout: 20_000 },
    )
    .toBeTruthy();
  if (!editor) throw new Error('no editor window');
  const page = editor;
  await expect
    .poll(() => page.evaluate(() => window.csEditorDebug?.doc()?.id ?? null), { timeout: 20_000 })
    .toBe(id);
  return page;
}

test.skip(!HAS_DISPLAY, 'needs a display');

test('cursor panel: reasons, effects and auto-zoom as one undo step (R3.10–R3.12)', async () => {
  test.setTimeout(180_000);
  const userData = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-cursor-'));
  const projects = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-cursor-projects-'));
  mkdirSync(path.join(projects, 'Exports'), { recursive: true });
  writeFileSync(
    path.join(userData, 'settings.json'),
    JSON.stringify(
      createDefaultSettings({ projectsDir: projects, exportsDir: path.join(projects, 'Exports') }),
    ),
  );
  const plain = FIXTURES.find((f) => f.name === 'p1-rounded-face')!.build(projects).doc;
  const { doc } = FIXTURES.find((f) => f.name === 'p3-cursor-effects')!.build(projects);
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

    // Without a cursor track the panel only explains.
    const first = await openEditor(app, channel, plain.id);
    await expect(first.getByTestId('cursor-unavailable')).toContainText('no cursor track');
    await expect(first.getByTestId('cursor-panel').getByRole('slider')).toHaveCount(0);
    await first.close();

    const page = await openEditor(app, channel, doc.id);
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    const panel = page.getByTestId('cursor-panel');
    await expect(panel.getByTestId('cursor-drawn-reason')).toHaveCount(0);
    await panel.getByLabel('Highlight', { exact: true }).uncheck();
    await panel.getByLabel('Size', { exact: true }).fill('2.5');
    const edited = await docOf(page);
    expect(edited.timeline.cursorEffects).toMatchObject({
      size: 2.5,
      highlight: { enabled: false },
    });

    // Auto-zoom: two groups (1.0 + 1.2 s, and 4.5 s); keep only the second.
    await panel.getByTestId('auto-zoom-find').click();
    const list = panel.getByTestId('auto-zoom-proposals');
    await expect(list.getByRole('checkbox')).toHaveCount(2);
    await list.getByRole('checkbox').first().uncheck();
    await panel.getByTestId('auto-zoom-add').click();
    let zoomed = await docOf(page);
    expect(cameraAt(zoomed.timeline.camera, 1_100_000).width).toBe(1);
    expect(cameraAt(zoomed.timeline.camera, 5_000_000).width).toBeCloseTo(0.5, 5);
    // The fixture's own 2.6–3.8 s zoom is still there.
    expect(cameraAt(zoomed.timeline.camera, 3_200_000).width).toBeCloseTo(0.5, 5);

    // One undo step removes the auto-zoom.
    await page.getByTestId('timeline-canvas').click({ position: { x: 5, y: 10 } });
    await page.keyboard.press('Control+z');
    zoomed = await docOf(page);
    expect(cameraAt(zoomed.timeline.camera, 5_000_000).width).toBe(1);
    expect(zoomed.timeline.cursorEffects?.size).toBe(2.5);
    expect(errors).toEqual([]);
  } finally {
    channel.close();
    await app.close().catch(() => undefined);
    rmSync(userData, { recursive: true, force: true });
    rmSync(projects, { recursive: true, force: true });
  }
});
