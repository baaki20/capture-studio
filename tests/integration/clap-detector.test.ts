/**
 * The clap cross-check of W1 (camera ↔ mic from claps, `clapOffsets` in `tests/sync/analysis.ts`)
 * against a synthetic clip shaped like real claps, made with the bundled FFmpeg: two "hands" that
 * speed up toward each other (fastest at contact), touch for 60 ms and part slowly; contacts fall
 * between frames (0.39 of a frame after one, drifting by 0.3 frame per clap); a 20 ms noise burst
 * at each contact; the camera mapped 40 ms late. Needs `npm run fetch:ffmpeg` first.
 */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clapOffsets, FFMPEG, type ProjectDoc } from '../sync/analysis';

const SECONDS = 9;
const FIRST = 1.413;
const PERIOD = 1.01;
const CAMERA_LATE_MS = 40;
let work: string;
let doc: ProjectDoc;

function ff(args: string[]): void {
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function media(role: string, kind: 'video' | 'audio', file: string, startOffsetUs = 0) {
  return {
    id: role,
    role,
    kind,
    path: `media/${file}`,
    startOffsetUs,
    syncAdjustUs: 0,
    clockRatio: 1,
    durationUs: SECONDS * 1_000_000,
  };
}

beforeAll(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-clap-'));
  const dir = path.join(work, 'media');
  await fs.mkdir(dir, { recursive: true });
  // Phase from the nearest contact, in [−0.5, 0.51) s.
  const p = `(mod(t-${String(FIRST)}+0.5\\,${String(PERIOD)})-0.5)`;
  // Gap between the hands (px): closing like sin (fastest at contact), 60 ms touching, parting.
  const gap =
    `if(lt(t\\,${String(FIRST - 0.5)})\\,100\\,` +
    `if(lt(${p}\\,0)\\,100*sin(PI*(-${p}))\\,if(lt(${p}\\,0.06)\\,0\\,` +
    `100*sin(PI/2*min(1\\,(${p}-0.06)/0.45)))))`;
  const d = String(SECONDS);
  ff([
    '-f',
    'lavfi',
    '-i',
    `color=c=0x303030:s=320x240:r=30:d=${d}[bg];` +
      `color=c=0xd0a080:s=40x80:r=30:d=${d}[l];color=c=0xd0a080:s=40x80:r=30:d=${d}[r];` +
      `[bg][l]overlay=x='120-(${gap})/2':y=80[a];[a][r]overlay=x='160+(${gap})/2':y=80`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    path.join(dir, 'camera.mp4'),
  ]);
  ff([
    '-f',
    'lavfi',
    '-i',
    `aevalsrc='0.8*(random(0)*2-1)*gte(t\\,${String(FIRST - 0.01)})*lt(mod(t-${String(FIRST)}\\,${String(PERIOD)})\\,0.02)':s=48000:d=${d}`,
    '-c:a',
    'libopus',
    '-b:a',
    '96k',
    path.join(dir, 'microphone.mp4'),
  ]);
  doc = {
    media: [
      media('camera', 'video', 'camera.mp4', CAMERA_LATE_MS * 1000),
      media('microphone', 'audio', 'microphone.mp4'),
    ],
  };
}, 60_000);

afterAll(async () => {
  if (work) await fs.rm(work, { recursive: true, force: true });
});

describe('clap cross-check on hand-like claps between frames', () => {
  it('finds every clap and measures camera − mic within a quarter frame', () => {
    const result = clapOffsets(work, doc, [0.5, SECONDS]);
    expect(result?.claps).toBe(8);
    expect(result?.pairs.length).toBe(8);
    const offsets = result?.pairs.map((p) => p.offsetMs) ?? [];
    console.info(`clap offsets (ms): ${offsets.map((o) => o.toFixed(1)).join(', ')}`);
    const median = result?.summary?.medianMs ?? NaN;
    expect(Math.abs(median - CAMERA_LATE_MS)).toBeLessThanOrEqual(8);
    for (const o of offsets) expect(Math.abs(o - CAMERA_LATE_MS)).toBeLessThanOrEqual(17);
  }, 60_000);
});
