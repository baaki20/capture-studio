/**
 * The frame-render export path in the media utility against the real bundled FFmpeg (§1.7, D4):
 * a stand-in renderer behind a real `RenderSession` streams known yuv420p frames over a
 * cross-wired frame port into `runExportJob`, which encodes them with the project's audio.
 * Checks the file (frame count, duration, BT.709 tags, audio), the pixels, the restart after a
 * failed hardware encoder, cancel, and a renderer failure. The WebGL side is covered by the
 * parity harness (`tests/e2e/parity.spec.ts`).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { locateFfmpeg, type FfmpegLocation } from '../../src/main/ffmpeg/locate';
import { frameSpec, yuvFrameBytes, type FrameSpec } from '../../src/shared/export/frame-render';
import type { ExportOptions } from '../../src/shared/ipc/contract';
import type { Project } from '../../src/shared/project/schema';
import { timelineDurationUs } from '../../src/shared/project/timeline-ops';
import type { FrameSink, RenderStats } from '../../src/renderer/render/frame-renderer';
import { RenderSession, type FramePort } from '../../src/renderer/render/render-session';
import { ExportError, runExportJob } from '../../src/utility/media/export/export-job';
import { FrameFeed } from '../../src/utility/media/export/frame-feed';
import { probeMedia } from '../../src/utility/media/probe';
import type { PortLike } from '../../src/utility/media/stream-writer';
import { recordedProject } from '../fixtures/editor-project';

const ROOT = path.join(import.meta.dirname, '../..');
const W = 128;
const H = 72;
const SECONDS = 2;
const OPTIONS: ExportOptions = {
  resolution: 'canvas',
  fps: 30,
  quality: 'draft',
  encoder: 'software',
  videoPath: 'frames',
};

let ffmpeg: FfmpegLocation;
let work: string;
let root: string;
let doc: Project;

function ff(args: string[]): Buffer {
  return execFileSync(ffmpeg.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Luma of output frame k: steps of 8, so a wrong or repeated frame shows. */
const lumaOf = (k: number) => 16 + ((k * 8) % 216);

/** Renders flat frames: Y = `lumaOf(k)`, neutral chroma. Can fail at a frame or go slowly. */
function flatRenderer(options: { failAt?: number; delayMs?: number } = {}) {
  let renders = 0;
  return {
    get renders() {
      return renders;
    },
    async render(spec: FrameSpec, sink: FrameSink, signal: AbortSignal): Promise<RenderStats> {
      renders += 1;
      const luma = spec.width * spec.height;
      for (let k = 0; k < spec.frames; k++) {
        if (signal.aborted) throw new Error('cancelled');
        if (k === options.failAt) throw new Error('Cannot decode media/screen.mp4: test');
        if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
        const frame = new Uint8Array(yuvFrameBytes(spec.width, spec.height)).fill(128);
        frame.fill(lumaOf(k), 0, luma);
        await sink.write(k, frame);
      }
      return { frames: spec.frames, inexact: 0 };
    },
  };
}

/** A frame port: the utility's end and the window's, delivering asynchronously like Electron. */
function framePort(): { utility: PortLike; window: FramePort } {
  let utilityListener: ((event: { data: unknown }) => void) | null = null;
  let closeListener: (() => void) | null = null;
  let closed = false;
  const window: FramePort = {
    onmessage: null,
    postMessage: (message) => {
      // Like Electron, the bytes arrive as a copy.
      const copy = structuredClone(message);
      setTimeout(() => utilityListener?.({ data: copy }), 0);
    },
    close: () => {
      if (closed) return;
      closed = true;
      setTimeout(() => closeListener?.(), 0);
    },
  };
  const utility: PortLike = {
    on(event: 'message' | 'close', listener: never) {
      if (event === 'message') utilityListener = listener;
      else closeListener = listener;
      return utility;
    },
    postMessage: (message) =>
      setTimeout(() => window.onmessage?.({ data: structuredClone(message) } as MessageEvent), 0),
    start: () => undefined,
    close: () => {
      closed = true;
    },
  };
  return { utility, window };
}

async function exportWith(
  name: string,
  renderer: ReturnType<typeof flatRenderer>,
  extra: Partial<Parameters<typeof runExportJob>[0]> = {},
  options: ExportOptions = OPTIONS,
) {
  const spec = frameSpec(doc, options, timelineDurationUs(doc));
  const port = framePort();
  const session = new RenderSession(port.window, renderer, spec, () => undefined);
  const feed = new FrameFeed(port.utility, spec);
  const output = path.join(work, 'Exports', `${name}.mp4`);
  try {
    return {
      output,
      spec,
      session,
      result: await runExportJob({
        ffmpegPath: ffmpeg.ffmpeg,
        ffprobePath: ffmpeg.ffprobe,
        root,
        doc,
        options,
        hardwareEncoder: null,
        output,
        overwrite: true,
        frames: feed,
        ...extra,
      }),
    };
  } finally {
    feed.stop();
  }
}

/** Mean Y code (limited range, as encoded) of output frame `n`. */
function meanLuma(file: string, n: number): number {
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
    'yuv420p',
    '-',
  ]).subarray(0, W * H);
  return data.reduce((sum, v) => sum + v, 0) / data.length;
}

beforeAll(async () => {
  const located = await locateFfmpeg({ isPackaged: false, resourcesPath: '', appPath: ROOT });
  if (!located.ok) throw located.error;
  ffmpeg = located.value;
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-export-frames-'));
  root = path.join(work, 'Frames.cstudio');
  await fs.mkdir(path.join(root, 'media'), { recursive: true });
  await fs.mkdir(path.join(work, 'Exports'), { recursive: true });
  doc = recordedProject({
    durationUs: SECONDS * 1_000_000,
    pauses: [],
    camera: false,
    system: false,
    screenSize: { width: W, height: H },
    offsets: { screen: 0, microphone: 0 },
  });
  // Only the audio is read from media on this path; the screen file must exist all the same.
  ff([
    '-f',
    'lavfi',
    '-i',
    `color=c=gray:s=${String(W)}x${String(H)}:r=30:d=${String(SECONDS)}`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    path.join(root, 'media', 'screen.mp4'),
  ]);
  ff([
    '-f',
    'lavfi',
    '-i',
    `sine=f=440:r=48000:d=${String(SECONDS)}`,
    '-c:a',
    'libopus',
    path.join(root, 'media', 'microphone.mp4'),
  ]);
});

afterAll(async () => {
  await fs.rm(work, { recursive: true, force: true });
});

describe('frame-render export (D4)', () => {
  it('encodes the rendered frames, in order, with the audio and BT.709 tags', async () => {
    const { output, spec, result } = await exportWith('frames', flatRenderer());
    expect(spec.frames).toBe(60);
    expect(result.encoder).toBe('libx264');
    const probe = await probeMedia(ffmpeg.ffprobe, output);
    if (!probe.ok) throw probe.error;
    const video = probe.value.streams.find((s) => s.codecType === 'video');
    const audio = probe.value.streams.find((s) => s.codecType === 'audio');
    expect(video).toMatchObject({ width: W, height: H, colorSpace: 'bt709', colorRange: 'tv' });
    expect(audio).toBeTruthy();
    expect(Math.abs((probe.value.durationUs ?? 0) - SECONDS * 1_000_000)).toBeLessThan(40_000);
    for (const n of [0, 1, 17, 30, 59]) {
      expect(Math.abs(meanLuma(output, n) - lumaOf(n)), `frame ${String(n)}`).toBeLessThan(2);
    }
  });

  it('restarts rendering from frame 0 when the hardware encoder fails', async () => {
    const renderer = flatRenderer();
    const { output, result } = await exportWith(
      'fallback',
      renderer,
      // Quick Sync needs an Intel GPU and its media driver (not on CI): FFmpeg fails to open it.
      { hardwareEncoder: 'h264_qsv' },
      { ...OPTIONS, encoder: 'auto' },
    );
    if (result.fallback === null) {
      // This machine can encode with Quick Sync: nothing to fall back from.
      expect(result.encoder).toBe('h264_qsv');
      console.warn('frame-render fallback not exercised: h264_qsv works here');
      return;
    }
    expect(result.encoder).toBe('libx264');
    expect(renderer.renders).toBe(2);
    expect(Math.abs(meanLuma(output, 45) - lumaOf(45))).toBeLessThan(2);
  });

  it('fails with the renderer’s message, leaving no file', async () => {
    const error = await exportWith('broken', flatRenderer({ failAt: 20 })).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ExportError);
    expect((error as ExportError).code).toBe('failed');
    expect((error as Error).message).toBe('Rendering failed: Cannot decode media/screen.mp4: test');
    expect(existsSync(path.join(work, 'Exports', 'broken.mp4'))).toBe(false);
    expect(
      (await fs.readdir(path.join(work, 'Exports'))).filter((f) => f.includes('broken')),
    ).toEqual([]);
  });

  it('cancels mid-render, stopping the renderer and leaving no file', async () => {
    const controller = new AbortController();
    const renderer = flatRenderer({ delayMs: 5 });
    const error = await exportWith('cancelled', renderer, {
      signal: controller.signal,
      onProgress: (f) => {
        if (f !== null && f > 0) controller.abort();
      },
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect((error as ExportError).code).toBe('cancelled');
    expect(existsSync(path.join(work, 'Exports', 'cancelled.mp4'))).toBe(false);
  });
});
