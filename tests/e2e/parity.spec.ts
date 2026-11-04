/**
 * Preview/export parity harness (R1.48; §5 P2 acceptance a). For every fixture in
 * `parity/fixtures.ts`, at its 10 sampled frames:
 *
 * - the editor preview's real WebGL2 compositor output (decoded by WebCodecs in the preview
 *   worker, read back from its canvas) is compared with the same frame decoded from an export
 *   the app made with the frame-render path (hidden render window → frame port → FFmpeg):
 *   SSIM ≥ the fixture's minimum at canvas resolution;
 * - each colour-keyed region (the face) is within 2 px (1 px for the camera fixture, acceptance b) of the scene's rect in both pictures;
 * - for a Phase 1 fixture, the filter-graph export of the same project must match the
 *   frame-render export (SSIM ≥ 0.98), so switching paths (D4) changes nothing.
 *
 * Export frame n shows timeline time n/30; the preview is captured there (see
 * `PREVIEW_OFFSET_US`). A negative control checks that the metric notices a picture half a
 * second off.
 *
 * The app runs in test mode on X11 (no portal) with software WebGL; the editor is opened through
 * the test-only control channel.
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
import type { ExportOptions } from '../../src/shared/ipc/contract';
import type { Project } from '../../src/shared/project/schema';
import { createDefaultSettings } from '../../src/shared/settings/schema';
import { runExportJob } from '../../src/utility/media/export/export-job';
import { boxDistance, keyedBox, ssim, type Picture } from '../sync/image';
import { ChannelClient } from '../wayland/lib/channel-client';
import {
  exportFrameTimeUs,
  ff,
  FFMPEG,
  FFMPEG_DIR,
  FFPROBE,
  FIXTURES,
  type ParityFixture,
} from './parity/fixtures';

const ROOT = path.join(import.meta.dirname, '../..');
const MAIN = path.join(ROOT, 'out/main/index.js');
/** Frame-render vs filter-graph export of a Phase 1 project. */
const MIN_PATH_SSIM = 0.98;
/**
 * The preview shows the latest source frame at or before t, the export the nearest one; 1 µs
 * past the frame time covers the rounding of frame timestamps to µs, so both show the same
 * source frame while animations move by nothing measurable.
 */
const PREVIEW_OFFSET_US = 1;

const OPTIONS: ExportOptions = {
  resolution: 'canvas',
  fps: 30,
  quality: 'standard',
  encoder: 'software',
};

/** Export frame `n` as RGB at its size. */
function exportFrame(file: string, n: number, width: number, height: number): Picture {
  const data = ff([
    '-i',
    file,
    '-vf',
    `select=eq(n\\,${String(n)})`,
    '-fps_mode',
    'passthrough',
    '-frames:v',
    '1',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    '-',
  ]);
  expect(data.length).toBe(width * height * 3);
  return { width, height, data, channels: 3 };
}

async function previewFrame(editor: Page, tUs: number): Promise<Picture> {
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

/** Exports `doc` through the app (frame-render path); resolves with the output path. */
async function appExport(editor: Page, doc: Project): Promise<string> {
  const outcome = await editor.evaluate(
    ({ doc, options }) =>
      new Promise<{ ok: boolean; message: string }>((resolve) => {
        const api = window.csEditor;
        const offDone = api.export.onDone((event) => {
          offDone();
          offError();
          resolve({ ok: true, message: event.outputPath ?? '' });
        });
        const offError = api.export.onError((event) => {
          offDone();
          offError();
          resolve({ ok: false, message: event.message });
        });
        void api.export
          .start({ projectId: doc.id, options, doc, overwrite: true })
          .then((started) => {
            if (started.status !== 'started') {
              resolve({ ok: false, message: started.message ?? started.status });
            }
          });
      }),
    { doc, options: { ...OPTIONS, videoPath: 'frames' as const } },
  );
  if (!outcome.ok) throw new Error(`the app's export failed: ${outcome.message}`);
  return outcome.message;
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
  if (!editor) throw new Error('no editor window');
  const page = editor;
  await expect
    .poll(() => page.evaluate(() => window.csEditorDebug?.doc()?.id ?? null), { timeout: 20_000 })
    .toBe(id);
  return page;
}

interface FrameResult {
  n: number;
  ssim: number;
  /** Frame-render vs filter-graph export (Phase 1 fixtures). */
  paths: number | null;
  /** Largest region box distance from the scene, preview and export. */
  preview: number;
  export: number;
}

async function checkFixture(
  fixture: ParityFixture,
  app: ElectronApplication,
  channel: ChannelClient,
  projects: string,
): Promise<FrameResult[]> {
  const { root, doc } = fixture.build(projects);
  const editor = await openEditor(app, channel, doc.id);
  const opened = (await editor.evaluate(() => window.csEditorDebug?.doc()))!;
  expect(opened.name, 'the editor opened the fixture').toBe(doc.name);
  expect(opened.timeline, 'the editor kept every timeline field').toEqual(doc.timeline);
  const { width, height } = opened.timeline.canvas;

  const rendered = await appExport(editor, opened);
  let graph: string | null = null;
  if (fixture.phase1) {
    graph = path.join(projects, 'Exports', `${fixture.name}-graph.mp4`);
    await runExportJob({
      ffmpegPath: FFMPEG,
      ffprobePath: FFPROBE,
      root,
      doc: opened,
      options: OPTIONS,
      hardwareEncoder: null,
      output: graph,
      overwrite: true,
    });
  }

  const results: FrameResult[] = [];
  for (const n of fixture.frames) {
    const tUs = exportFrameTimeUs(n);
    const preview = await previewFrame(editor, tUs + PREVIEW_OFFSET_US);
    expect([preview.width, preview.height]).toEqual([width, height]);
    const exported = exportFrame(rendered, n, width, height);
    const score = ssim(preview, exported);
    if (n === fixture.frames[0]) {
      const later = ssim(preview, exportFrame(rendered, n + 15, width, height));
      console.info(`${fixture.name} control: frame ${String(n)} vs +15: ${later.toFixed(4)}`);
      expect(later, 'negative control').toBeLessThan(fixture.minSsim);
    }
    let previewWorst = 0;
    let exportWorst = 0;
    for (const region of fixture.regions) {
      const previewRect = region.rectAt(opened, tUs + PREVIEW_OFFSET_US);
      const exportRect = region.rectAt(opened, tUs);
      if (!previewRect || !exportRect) continue;
      const around = (r: typeof exportRect) => ({
        x: r.x - 12,
        y: r.y - 12,
        width: r.width + 24,
        height: r.height + 24,
      });
      const a = keyedBox(preview, region.key, around(previewRect));
      const b = keyedBox(exported, region.key, around(exportRect));
      expect(a, `${region.name} in the preview at frame ${String(n)}`).not.toBeNull();
      expect(b, `${region.name} in the export at frame ${String(n)}`).not.toBeNull();
      previewWorst = Math.max(previewWorst, boxDistance(a!, previewRect));
      exportWorst = Math.max(exportWorst, boxDistance(b!, exportRect));
    }
    const paths = graph ? ssim(exported, exportFrame(graph, n, width, height)) : null;
    const round = (x: number) => Math.round(x * 10_000) / 10_000;
    results.push({
      n,
      ssim: round(score),
      paths: paths === null ? null : round(paths),
      preview: round(previewWorst),
      export: round(exportWorst),
    });
  }
  await editor.close();
  return results;
}

test.skip(process.platform !== 'linux' || !process.env.DISPLAY, 'needs Linux with an X display');

test('preview and frame-render export agree for every parity fixture (R1.48, P2 a)', async () => {
  test.setTimeout(120_000 * FIXTURES.length);
  const userData = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-parity-'));
  const projects = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-parity-projects-'));
  mkdirSync(path.join(projects, 'Exports'), { recursive: true });
  const settings = createDefaultSettings({
    projectsDir: projects,
    exportsDir: path.join(projects, 'Exports'),
  });
  writeFileSync(path.join(userData, 'settings.json'), JSON.stringify(settings));
  const socket = path.join(userData, 'control.sock');
  const app = await electron.launch({
    // No GPU under Xvfb (CI): Chromium only falls back to software WebGL when asked.
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
    const report: Record<string, FrameResult[]> = {};
    for (const fixture of FIXTURES) {
      report[fixture.name] = await checkFixture(fixture, app, channel, projects);
      console.info(`parity ${fixture.name}: ${JSON.stringify(report[fixture.name])}`);
    }
    await test.info().attach('parity.json', {
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json',
    });
    for (const fixture of FIXTURES) {
      for (const r of report[fixture.name] ?? []) {
        const at = `${fixture.name} frame ${String(r.n)}`;
        expect(r.ssim, `SSIM at ${at}`).toBeGreaterThanOrEqual(fixture.minSsim);
        if (r.paths !== null) {
          expect(r.paths, `frame render vs filter graph at ${at}`).toBeGreaterThanOrEqual(
            MIN_PATH_SSIM,
          );
        }
        const maxPx = fixture.maxRegionPx ?? 2;
        expect(r.preview, `preview regions at ${at}`).toBeLessThanOrEqual(maxPx);
        expect(r.export, `export regions at ${at}`).toBeLessThanOrEqual(maxPx);
      }
    }
  } finally {
    channel.close();
    await app.close().catch(() => undefined);
    rmSync(userData, { recursive: true, force: true });
    // CS_PARITY_KEEP=1 keeps the projects and exports for inspection (delete them afterwards).
    if (process.env.CS_PARITY_KEEP) console.info(`parity: kept ${projects}`);
    else rmSync(projects, { recursive: true, force: true });
  }
});
