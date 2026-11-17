/**
 * Media in the editor (R2.21, R2.22, acceptance g), driven through the UI with the native file
 * dialogs stubbed in the main process:
 * - Import… puts a PNG into the project as a one-frame video and shows it on a new track above
 *   the screen (the preview shows its orange at the playhead);
 * - Add a take… copies another recorded project's media in, on new "(take)" tracks, one undo step;
 * - a 4K recording gets a 720p proxy in the cache, which the preview decodes instead of the
 *   original (the < 1 % late-frame figure of acceptance g needs a real display; see the test).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import type { Project } from '../../src/shared/project/schema';
import { createDefaultSettings } from '../../src/shared/settings/schema';
import { buildRecordedProject } from '../fixtures/recorded-media';
import { ChannelClient } from '../wayland/lib/channel-client';
import { FFMPEG, FFMPEG_DIR, FPS } from './parity/fixtures';
import { HAS_DISPLAY, HAS_WEBGL, controlSocketPath, SOFTWARE_GL_ARGS } from './platform';

const ROOT = path.join(import.meta.dirname, '../..');
const MAIN = path.join(ROOT, 'out/main/index.js');
const S = 1_000_000;

function ff(args: string[]): void {
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
}

/** A recorded project folder: screen of `size`, a camera and a microphone, `seconds` long. */
function buildProject(
  dir: string,
  id: string,
  name: string,
  size: [number, number],
  seconds: number,
): { root: string; doc: Project } {
  return buildRecordedProject({ ffmpeg: FFMPEG, fps: FPS, dir, id, name, size, seconds });
}

async function launch(userData: string, projects: string) {
  writeFileSync(
    path.join(userData, 'settings.json'),
    JSON.stringify(
      createDefaultSettings({ projectsDir: projects, exportsDir: path.join(projects, 'Exports') }),
    ),
  );
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
  await app.firstWindow();
  return { app, channel };
}

async function openEditor(
  app: ElectronApplication,
  channel: ChannelClient,
  id: string,
): Promise<Page> {
  await channel.call('editor.open', { projectId: id });
  let editor: Page | undefined;
  await expect
    .poll(() => (editor = app.windows().find((w) => w.url().includes('editor/index.html'))), {
      timeout: 20_000,
    })
    .toBeTruthy();
  const page = editor!;
  await expect
    .poll(() => page.evaluate(() => window.csEditorDebug?.doc()?.id ?? null), { timeout: 20_000 })
    .toBe(id);
  return page;
}

/** The next file or folder dialog answers with `paths`. */
async function stubDialog(app: ElectronApplication, paths: string[]) {
  await app.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths });
  }, paths);
}

const docOf = async (page: Page) => (await page.evaluate(() => window.csEditorDebug?.doc()))!;

test.skip(!HAS_DISPLAY, 'needs a display');

test('import a picture and add a take (R2.21, R2.22)', async () => {
  test.skip(!HAS_WEBGL, 'needs WebGL2 (the preview draws the frame)');
  test.setTimeout(180_000);
  const userData = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-media-'));
  const projects = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-media-projects-'));
  mkdirSync(path.join(projects, 'Exports'), { recursive: true });
  const { doc } = buildProject(
    projects,
    'prj_01JBQ4ZJ4X6V3K8N2M7P5R9TMA',
    'Media main',
    [1280, 720],
    6,
  );
  const takeDir = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-media-take-'));
  const take = buildProject(
    takeDir,
    'prj_01JBQ4ZJ4X6V3K8N2M7P5R9TMB',
    'Media take',
    [1280, 720],
    3,
  );
  const png = path.join(takeDir, 'logo.png');
  ff(['-f', 'lavfi', '-i', 'color=c=0xFF8000:s=640x360', '-frames:v', '1', png]);
  const { app, channel } = await launch(userData, projects);
  try {
    const page = await openEditor(app, channel, doc.id);
    const panel = page.getByTestId('media-panel');

    await stubDialog(app, [png]);
    await panel.getByRole('button', { name: 'Import…' }).click();
    await expect
      .poll(async () => (await docOf(page)).timeline.tracks.map((t) => t.name))
      .toEqual(['Screen', 'logo', 'Face', 'Voice']);
    const imported = (await docOf(page)).timeline.tracks[1]!;
    expect(imported.clips[0]).toMatchObject({
      freeze: true,
      timelineStartUs: 0,
      durationUs: 5 * S,
    });
    // The picture fills the middle of the frame at 1 s: orange.
    await expect
      .poll(
        async () => {
          const shot = await page.evaluate(() => window.csEditorDebug?.capturePreview(1_000_000));
          if (!shot?.exact) return null;
          const bytes = Buffer.from(shot.rgbaBase64, 'base64');
          const i = ((shot.height / 2) * shot.width + shot.width / 2) * 4;
          const [r, g, b] = [bytes[i] ?? 0, bytes[i + 1] ?? 0, bytes[i + 2] ?? 0];
          return r > 230 && g > 105 && g < 155 && b < 30;
        },
        { timeout: 20_000 },
      )
      .toBe(true);

    await stubDialog(app, [take.root]);
    await panel.getByRole('button', { name: 'Add a take…' }).click();
    await expect
      .poll(
        async () =>
          (await docOf(page)).timeline.tracks.filter((t) => t.name.endsWith('(take)')).length,
      )
      .toBe(3);
    const after = await docOf(page);
    expect(after.media).toHaveLength(doc.media.length + 1 + 3);
    await page.getByTestId('timeline-canvas').click({ position: { x: 5, y: 10 } });
    await page.keyboard.press('Control+z');
    await expect.poll(async () => (await docOf(page)).timeline.tracks.length).toBe(4);
  } finally {
    channel.close();
    await app.close().catch(() => undefined);
    rmSync(userData, { recursive: true, force: true });
    rmSync(projects, { recursive: true, force: true });
    rmSync(takeDir, { recursive: true, force: true });
  }
});

test('a 4K recording gets a 720p proxy that the preview plays (acceptance g)', async () => {
  test.setTimeout(240_000);
  const userData = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-proxy-'));
  const projects = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-proxy-projects-'));
  mkdirSync(path.join(projects, 'Exports'), { recursive: true });
  const { root, doc } = buildProject(
    projects,
    'prj_01JBQ4ZJ4X6V3K8N2M7P5R9TMC',
    'Media 4K',
    [3840, 2160],
    8,
  );
  const { app, channel } = await launch(userData, projects);
  try {
    const page = await openEditor(app, channel, doc.id);
    const screen = doc.media.find((m) => m.role === 'screen')!;
    const proxy = path.join(root, 'cache', `${screen.id}.proxy.mp4`);
    await expect.poll(() => existsSync(proxy), { timeout: 120_000 }).toBe(true);
    // The preview switches to the proxy; the export keeps the original.
    await expect
      .poll(() => page.evaluate((id) => window.csEditorDebug?.previewUrls()[id] ?? '', screen.id), {
        timeout: 20_000,
      })
      .toMatch(/\.proxy\.mp4$/);
    expect((await docOf(page)).media.find((m) => m.id === screen.id)?.path).toBe(
      'media/screen.mp4',
    );
    // Playback counters, for information: software GL under Xvfb cannot keep up with playback
    // even at 720p, so the < 1 % late-frame check (acceptance g) runs on a real display.
    const counters = await page.evaluate(async () => {
      window.csEditorDebug?.resetPlaybackCounters();
      window.csEditorDebug?.play(0);
      await new Promise((r) => setTimeout(r, 5000));
      window.csEditorDebug?.pause();
      return window.csEditorDebug?.playbackCounters().video ?? null;
    });
    console.info(`proxy playback: ${JSON.stringify(counters)}`);
    expect(counters).not.toBeNull();
  } finally {
    channel.close();
    await app.close().catch(() => undefined);
    rmSync(userData, { recursive: true, force: true });
    rmSync(projects, { recursive: true, force: true });
  }
});

test('export dialog: Small GIF preset and Save frame as PNG (R2.24–R2.26)', async () => {
  test.skip(!HAS_WEBGL, 'needs WebGL2 (the preview draws the frame)');
  test.setTimeout(180_000);
  const userData = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-formats-'));
  const projects = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-formats-projects-'));
  mkdirSync(path.join(projects, 'Exports'), { recursive: true });
  const { doc } = buildProject(
    projects,
    'prj_01JBQ4ZJ4X6V3K8N2M7P5R9TMD',
    'Formats',
    [1280, 720],
    4,
  );
  const { app, channel } = await launch(userData, projects);
  try {
    const page = await openEditor(app, channel, doc.id);
    await page
      .getByRole('button', { name: /^Export/ })
      .first()
      .click();
    const dialog = page.getByTestId('export-dialog');
    await dialog.getByLabel('Preset').selectOption('small-gif');
    await expect(dialog.getByLabel('Format')).toHaveValue('gif');
    await expect(dialog.getByText(/Formats\.gif$/)).toBeVisible();
    // Unsafe advanced options block the export until fixed.
    const options = dialog.getByLabel('FFmpeg options');
    await options.fill('-i other.mp4');
    await expect(dialog.getByRole('button', { name: 'Export', exact: true })).toBeDisabled();
    await options.fill('');

    const frame = path.join(projects, 'Exports', 'Still.png');
    await app.evaluate(({ dialog: d }, filePath) => {
      d.showSaveDialog = () => Promise.resolve({ canceled: false, filePath });
    }, frame);
    await dialog.getByRole('button', { name: 'Save frame as PNG' }).click();
    await expect(dialog.getByText('Saved Still.png.')).toBeVisible({ timeout: 20_000 });
    expect(
      execFileSync(
        FFMPEG.replace(/ffmpeg$/, 'ffprobe'),
        ['-v', 'error', '-show_entries', 'stream=codec_name,width', '-of', 'csv=p=0', frame],
        { encoding: 'utf8' },
      ).trim(),
    ).toBe('png,1280');

    await dialog.getByRole('button', { name: 'Export', exact: true }).click();
    await expect(dialog.getByText(/Exported/)).toBeVisible({ timeout: 120_000 });
    const gif = path.join(projects, 'Exports', 'Formats.gif');
    expect(
      execFileSync(
        FFMPEG.replace(/ffmpeg$/, 'ffprobe'),
        ['-v', 'error', '-show_entries', 'stream=codec_name,width', '-of', 'csv=p=0', gif],
        { encoding: 'utf8' },
      ).trim(),
    ).toBe('gif,480');
  } finally {
    channel.close();
    await app.close().catch(() => undefined);
    rmSync(userData, { recursive: true, force: true });
    rmSync(projects, { recursive: true, force: true });
  }
});
