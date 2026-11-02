/**
 * Preview/export parity (R1.48): for 10 timeline instants, the editor preview's real WebGL2
 * compositor output (decoded by WebCodecs in the preview worker, read back from its canvas) is
 * compared with the same instant decoded from an export made by the FFmpeg export graph.
 * SSIM must be at least 0.98 (R1.48 says 0.95; see MIN_SSIM) at canvas resolution, and the
 * face overlay's bounding box (a magenta camera, colour-keyed) must be within 2 px of the render
 * plan's rect in both.
 *
 * The project is synthetic: a 1280×720 grey `testsrc2` screen and a magenta 640×480 camera,
 * BT.601 tagged like WebCodecs recordings, with a rounded face overlay. The app runs in test mode
 * on X11 (no portal); the editor is opened through the test-only control channel.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import type { ExportOptions } from '../../src/shared/ipc/contract';
import { layersAt } from '../../src/shared/project/render-plan';
import type { ProjectV1 } from '../../src/shared/project/schema';
import { applyOp } from '../../src/shared/project/timeline-ops';
import { unwrap } from '../../src/shared/result';
import { createDefaultSettings } from '../../src/shared/settings/schema';
import { runExportJob } from '../../src/utility/media/export/export-job';
import { counterIds, recordedProject, trackByName } from '../fixtures/editor-project';
import { boxDistance, keyedBox, ssim, type Picture } from '../sync/image';
import { ChannelClient } from '../wayland/lib/channel-client';

const ROOT = path.join(import.meta.dirname, '../..');
const MAIN = path.join(ROOT, 'out/main/index.js');
const FFMPEG_DIR = path.join(ROOT, 'resources/bin', `${process.platform}-${process.arch}`);
const FFMPEG = path.join(FFMPEG_DIR, 'ffmpeg');
const FFPROBE = path.join(FFMPEG_DIR, 'ffprobe');
const W = 1280;
const H = 720;
const SECONDS = 6;
const FRAMES = [8, 25, 42, 59, 76, 93, 110, 127, 144, 161];
/**
 * R1.48 asks for 0.95; this test holds 0.98, because on this content a picture half a second
 * off still scores about 0.96 (the negative control below), so 0.95 would not catch a wrong frame.
 */
const MIN_SSIM = 0.98;

const BT601 = [
  '-pix_fmt',
  'yuv420p',
  '-colorspace',
  'smpte170m',
  '-color_primaries',
  'smpte170m',
  '-color_trc',
  'smpte170m',
];

function ff(args: string[]): Buffer {
  return execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });
}

function makeProject(projects: string): { root: string; doc: ProjectV1 } {
  let doc = recordedProject({
    durationUs: SECONDS * 1_000_000,
    pauses: [],
    mic: false,
    system: false,
    screenSize: { width: W, height: H },
    cameraSize: { width: 640, height: 480 },
    offsets: { screen: 0, camera: 0 },
  });
  const face = trackByName(doc, 'Face').id;
  doc = unwrap(
    applyOp(
      doc,
      {
        type: 'setLayout',
        trackId: face,
        layout: { shape: 'rounded', cornerRadius: 0.2, width: 0.3, centerX: 0.72, centerY: 0.66 },
      },
      { generateId: counterIds('P') },
    ),
  );
  const root = path.join(projects, 'Parity.cstudio');
  const media = path.join(root, 'media');
  mkdirSync(media, { recursive: true });
  const d = String(SECONDS);
  ff([
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${String(W)}x${String(H)}:rate=30:duration=${d}`,
    // Grey, so only the face is magenta (its colour key).
    '-vf',
    'hue=s=0',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '16',
    '-g',
    '30',
    ...BT601,
    path.join(media, 'screen.mp4'),
  ]);
  ff([
    '-f',
    'lavfi',
    '-i',
    `color=c=0xFF00FF:s=640x480:r=30:d=${d}`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    ...BT601,
    path.join(media, 'camera.mp4'),
  ]);
  writeFileSync(path.join(root, 'project.json'), JSON.stringify(doc, null, 2));
  return { root, doc };
}

/** Export frame `n` as RGB at canvas size. */
function exportFrame(file: string, n: number): Picture {
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
  expect(data.length).toBe(W * H * 3);
  return { width: W, height: H, data, channels: 3 };
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

const magenta = (r: number, g: number, b: number) => r > 170 && g < 90 && b > 170;

test.skip(process.platform !== 'linux' || !process.env.DISPLAY, 'needs Linux with an X display');

test('preview and export agree: SSIM ≥ 0.98 and the face box within 2 px (R1.48)', async () => {
  test.setTimeout(180_000);
  const userData = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-parity-'));
  const projects = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-parity-projects-'));
  const settings = createDefaultSettings({
    projectsDir: projects,
    exportsDir: path.join(projects, 'Exports'),
  });
  writeFileSync(path.join(userData, 'settings.json'), JSON.stringify(settings));
  const { root, doc } = makeProject(projects);
  const socket = path.join(userData, 'control.sock');
  const app = await electron.launch({
    // No GPU under Xvfb (CI): Chromium only falls back to software WebGL for the preview when asked.
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
    await expect
      .poll(() => editor!.evaluate(() => window.csEditorDebug?.doc()?.id ?? null), {
        timeout: 20_000,
      })
      .toBe(doc.id);
    const opened = (await editor.evaluate(() => window.csEditorDebug?.doc()))!;
    expect(opened.timeline.canvas).toMatchObject({ width: W, height: H });

    const output = path.join(projects, 'Exports', 'parity.mp4');
    const options: ExportOptions = {
      resolution: 'canvas',
      fps: 'project',
      quality: 'standard',
      encoder: 'software',
    };
    await runExportJob({
      ffmpegPath: FFMPEG,
      ffprobePath: FFPROBE,
      root,
      doc: opened,
      options,
      hardwareEncoder: null,
      output,
      overwrite: false,
    });

    const results: { n: number; ssim: number; preview: number; export: number }[] = [];
    for (const n of FRAMES) {
      const tUs = Math.round(((n + 0.5) / 30) * 1_000_000);
      const preview = await previewFrame(editor, tUs);
      expect([preview.width, preview.height]).toEqual([W, H]);
      const exported = exportFrame(output, n);
      const face = layersAt(opened, tUs).find((l) => l.kind === 'overlay');
      expect(face).toBeTruthy();
      if (!face) return;
      const rect = face.destRect;
      const around = {
        x: rect.x - 12,
        y: rect.y - 12,
        width: rect.width + 24,
        height: rect.height + 24,
      };
      const previewBox = keyedBox(preview, magenta, around);
      const exportBox = keyedBox(exported, magenta, around);
      expect(previewBox, `preview face at frame ${String(n)}`).not.toBeNull();
      expect(exportBox, `export face at frame ${String(n)}`).not.toBeNull();
      const score = ssim(preview, exported);
      if (n === FRAMES[0]) {
        // Negative control: half a second later scores lower, so the metric sees motion.
        const later = ssim(preview, exportFrame(output, n + 15));
        console.info(
          `parity control: frame ${String(n)} vs ${String(n + 15)}: ${later.toFixed(4)}`,
        );
        expect(later).toBeLessThan(MIN_SSIM);
      }
      results.push({
        n,
        ssim: Math.round(score * 10_000) / 10_000,
        preview: boxDistance(previewBox!, rect),
        export: boxDistance(exportBox!, rect),
      });
    }
    await test.info().attach('parity.json', {
      body: JSON.stringify(results, null, 2),
      contentType: 'application/json',
    });
    console.info(`parity (frame: ssim, preview box Δ, export box Δ): ${JSON.stringify(results)}`);
    for (const r of results) {
      expect(r.ssim, `SSIM at frame ${String(r.n)}`).toBeGreaterThanOrEqual(MIN_SSIM);
      expect(r.preview, `preview face box at frame ${String(r.n)}`).toBeLessThanOrEqual(2);
      expect(r.export, `export face box at frame ${String(r.n)}`).toBeLessThanOrEqual(2);
    }
  } finally {
    channel.close();
    await app.close().catch(() => undefined);
    rmSync(userData, { recursive: true, force: true });
    rmSync(projects, { recursive: true, force: true });
  }
});
