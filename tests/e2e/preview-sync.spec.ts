/**
 * Sync in the editor preview (R1.24, OD-1): the screen and the mic, as the preview shows and
 * plays them, stay within 40 ms of each other.
 *
 * The project is synthetic and in sync by construction: a black 640×360 screen that turns white
 * for 200 ms at 1, 3, 5, 7 and 9 s, and a mic track with a 50 ms 1 kHz beep at the same instants.
 * (Small and long enough that software WebGL and decoding under Xvfb keep up: this tests sync,
 * not throughput.) The editor plays it from the start and the page measures both outputs on its
 * own clock (`performance.now()`), without using the app's playback code:
 * - picture: the preview canvas is read back on every animation frame; a flash is the first
 *   white read. The compositor shows it at the next refresh, up to one frame later;
 * - sound: an analyser on every node the app connects to the speakers (`AudioDestinationNode`);
 *   a beep onset in its samples is converted to the time it is played out with the context's
 *   `getOutputTimestamp()`.
 * It also logs both against the playhead (the time the app believes is heard), to show which
 * side is off when the test fails. Before the preview rendered ahead (`render-latency.ts`), the
 * picture was 55–110 ms behind the sound here.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { createDefaultSettings } from '../../src/shared/settings/schema';
import { recordedProject } from '../fixtures/editor-project';
import { ChannelClient } from '../wayland/lib/channel-client';

const ROOT = path.join(import.meta.dirname, '../..');
const MAIN = path.join(ROOT, 'out/main/index.js');
const FFMPEG_DIR = path.join(ROOT, 'resources/bin', `${process.platform}-${process.arch}`);
const FFMPEG = path.join(FFMPEG_DIR, 'ffmpeg');
const W = 640;
const H = 360;
const SECONDS = 10;
/** Flash and beep instants (s): odd seconds. */
const MARKS = [1, 3, 5, 7, 9];
/** R1.24: screen ↔ audio within 40 ms. */
const MAX_OFFSET_MS = 40;

function ff(args: string[]): void {
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
}

function makeProject(projects: string) {
  const doc = recordedProject({
    durationUs: SECONDS * 1_000_000,
    pauses: [],
    camera: false,
    mic: true,
    system: false,
    screenSize: { width: W, height: H },
    offsets: { screen: 0, microphone: 0 },
  });
  const root = path.join(projects, 'Sync.cstudio');
  const media = path.join(root, 'media');
  mkdirSync(media, { recursive: true });
  const d = String(SECONDS);
  const mark = (width: number) => `gte(t\\,1)*lt(mod(t-1\\,2)\\,${String(width)})`;
  ff([
    '-f',
    'lavfi',
    '-i',
    `color=c=black:s=${String(W)}x${String(H)}:r=30:d=${d}`,
    '-vf',
    `drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='${mark(0.2)}'`,
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
    `aevalsrc='${mark(0.05)}*0.8*sin(2*PI*1000*t)':s=48000:d=${d}`,
    '-c:a',
    'libopus',
    '-b:a',
    '96k',
    path.join(media, 'microphone.mp4'),
  ]);
  writeFileSync(path.join(root, 'project.json'), JSON.stringify(doc, null, 2));
  return doc;
}

/**
 * Runs in every page before its scripts: taps each node the app connects to the speakers. The
 * editor's own code is untouched; the tap only listens.
 */
function installAudioTap(): void {
  interface Tap {
    analysers: AnalyserNode[];
  }
  const tap: Tap = { analysers: [] };
  (globalThis as { __csAudioTap?: Tap }).__csAudioTap = tap;
  // Always called with `.call(this, …)` below.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const connect = AudioNode.prototype.connect as (
    this: AudioNode,
    destination: AudioNode | AudioParam,
    ...rest: number[]
  ) => AudioNode | undefined;
  AudioNode.prototype.connect = function (
    this: AudioNode,
    destination: AudioNode | AudioParam,
    ...rest: number[]
  ) {
    if (destination instanceof AudioDestinationNode) {
      const analyser = new AnalyserNode(destination.context, { fftSize: 4096 });
      connect.call(this, analyser);
      tap.analysers.push(analyser);
    }
    return connect.call(this, destination, ...rest);
  } as typeof AudioNode.prototype.connect;
}

interface Measured {
  flashes: number[];
  beeps: number[];
  crossings: number[];
  captured: number;
  counters: unknown;
}

/** Plays from the start and collects flash and beep times (performance.now, ms). */
async function measure(editor: Page, seconds: number): Promise<Measured> {
  return editor.evaluate(
    async ({ ms, marksUs }) => {
      const tap = (globalThis as { __csAudioTap?: { analysers: AnalyserNode[] } }).__csAudioTap;
      if (!tap) throw new Error('the audio tap is not installed');
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="preview"] canvas');
      if (!canvas) throw new Error('no preview canvas');

      // Picture: the preview canvas read back on every animation frame. What it holds then is
      // what the compositor shows at the next refresh.
      const probe = new OffscreenCanvas(16, 16).getContext('2d', { willReadFrequently: true });
      if (!probe) throw new Error('no 2d context');
      const flashes: number[] = [];
      const crossings: number[] = [];
      let captured = 0;
      let wasBright = false;
      let running = true;
      const onFrame = (now: number): void => {
        if (!running) return;
        captured += 1;
        probe.drawImage(canvas, 0, 0, 16, 16);
        const px = probe.getImageData(0, 0, 16, 16).data;
        let sum = 0;
        for (let i = 0; i < px.length; i += 4) sum += px[i] ?? 0;
        const bright = sum / (px.length / 4) > 128;
        if (bright && !wasBright) flashes.push(now);
        const playhead = window.csEditorDebug?.ui().playheadUs ?? 0;
        while (crossings.length < marksUs.length && playhead >= (marksUs[crossings.length] ?? 0)) {
          crossings.push(now);
        }
        wasBright = bright;
        requestAnimationFrame(onFrame);
      };
      requestAnimationFrame(onFrame);

      // Sound: poll the analysers; a beep onset is the first loud sample after silence.
      const beeps: number[] = [];
      let lastBeep = -Infinity;
      const poll = (): void => {
        for (const analyser of tap.analysers) {
          const context = analyser.context as AudioContext;
          if (context.state !== 'running') continue;
          const samples = new Float32Array(analyser.fftSize);
          analyser.getFloatTimeDomainData(samples);
          const now = context.currentTime;
          const stamp = context.getOutputTimestamp();
          const index = samples.findIndex((v) => Math.abs(v) > 0.2);
          if (index <= 0) continue;
          const onsetCtx = now - (samples.length - index) / context.sampleRate;
          const onset = (stamp.performanceTime ?? 0) + (onsetCtx - (stamp.contextTime ?? 0)) * 1000;
          if (onset - lastBeep > 500) {
            beeps.push(onset);
            lastBeep = onset;
          }
        }
      };
      const timer = setInterval(poll, 20);

      window.csEditorDebug?.play(0);
      await new Promise((r) => setTimeout(r, ms));
      running = false;
      clearInterval(timer);
      window.csEditorDebug?.pause();
      return {
        flashes,
        beeps,
        crossings,
        captured,
        counters: window.csEditorDebug?.playbackCounters(),
      };
    },
    { ms: seconds * 1000, marksUs: MARKS.map((m) => m * 1_000_000) },
  );
}

test.skip(process.platform !== 'linux' || !process.env.DISPLAY, 'needs Linux with an X display');

test('the editor preview plays screen and mic within 40 ms of each other (R1.24)', async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-sync-'));
  const projects = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-sync-projects-'));
  const settings = createDefaultSettings({
    projectsDir: projects,
    exportsDir: path.join(projects, 'Exports'),
  });
  writeFileSync(path.join(userData, 'settings.json'), JSON.stringify(settings));
  const doc = makeProject(projects);
  const socket = path.join(userData, 'control.sock');
  const app = await electron.launch({
    // No GPU under Xvfb (CI): Chromium only falls back to software WebGL for the preview when asked.
    args: [
      '--ozone-platform=x11',
      '--enable-unsafe-swiftshader',
      '--disable-features=WebRTCPipeWireCapturer',
      '--autoplay-policy=no-user-gesture-required',
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
  await app.context().addInitScript(installAudioTap);
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
    // The preview shows the first (black) frame before playing.
    await expect
      .poll(() =>
        editor!.evaluate(async () => (await window.csEditorDebug?.probePreview(0))?.exact),
      )
      .toBe(true);

    const result = await measure(editor, SECONDS + 0.5);
    console.info(`preview sync: ${JSON.stringify(result)}`);
    await test.info().attach('preview-sync.json', {
      body: JSON.stringify(result, null, 2),
      contentType: 'application/json',
    });
    expect(result.beeps).toHaveLength(MARKS.length);
    expect(result.flashes).toHaveLength(MARKS.length);
    const offsets = result.flashes.map((f, i) => f - (result.beeps[i] ?? NaN));
    console.info(
      `preview sync offsets (picture − sound, ms): ${offsets.map((o) => o.toFixed(1)).join(', ')}`,
    );
    const minus = (a: number[], b: number[]) =>
      a.map((v, i) => (v - (b[i] ?? NaN)).toFixed(1)).join(', ');
    console.info(`picture − clock: ${minus(result.flashes, result.crossings)}`);
    console.info(`sound − clock: ${minus(result.beeps, result.crossings)}`);
    for (const [i, offset] of offsets.entries()) {
      expect(Math.abs(offset), `offset at ${String(MARKS[i])} s`).toBeLessThanOrEqual(
        MAX_OFFSET_MS,
      );
    }
  } finally {
    channel.close();
    await app.close().catch(() => undefined);
    rmSync(userData, { recursive: true, force: true });
    rmSync(projects, { recursive: true, force: true });
  }
});
