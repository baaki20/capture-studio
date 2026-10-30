/**
 * The sync analyzer (`tests/sync/analysis.ts`; R1.14, R1.24) against a synthetic recording with
 * known offsets, made with the bundled FFmpeg: screen flashes, camera flashes 50 ms late, mic
 * beeps 20 ms late, system beeps 10 ms early, then a clap segment (a block that stops moving at
 * each contact, and a noise burst 10 ms before it). Also the exported-file mode and the pause
 * content checks (red frames, the 3 kHz pause tone). Needs `npm run fetch:ffmpeg` first.
 */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  analyzeExport,
  analyzeProject,
  FFMPEG,
  pauseToneSpans,
  redFrames,
  videoStats,
} from '../sync/analysis';

const SECONDS = 30;
let work: string;
let project: string;

function ff(args: string[]): void {
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const H264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'];
const OPUS = ['-c:a', 'libopus', '-b:a', '96k'];
const FLASHING = 'gte(t,1)*lt(t,20)';

function media(role: string, kind: 'video' | 'audio', file: string) {
  return {
    id: role,
    role,
    kind,
    path: `media/${file}`,
    startOffsetUs: 0,
    syncAdjustUs: 0,
    clockRatio: 1,
    durationUs: SECONDS * 1_000_000,
  };
}

beforeAll(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-sync-analysis-'));
  project = path.join(work, 'Sync.cstudio');
  const dir = path.join(project, 'media');
  await fs.mkdir(dir, { recursive: true });
  const d = String(SECONDS);
  // Screen: black, full white for 120 ms every 2 s.
  ff([
    '-f',
    'lavfi',
    '-i',
    `color=c=black:s=320x180:r=30:d=${d}[bg];color=c=white:s=320x180:r=30:d=${d}[w];` +
      `[bg][w]overlay=enable='lt(mod(t\\,2)\\,0.12)*${FLASHING}'`,
    ...H264,
    path.join(dir, 'screen.mp4'),
  ]);
  // Camera: the flash lights the room 50 ms later; then a block that stops at each "clap".
  const clapX = `if(gte(t\\,22)\\,if(lt(mod(t-22\\,1.5)\\,0.4)\\,20+mod(t-22\\,1.5)*500\\,220)\\,220)`;
  ff([
    '-f',
    'lavfi',
    '-i',
    `color=c=0x202020:s=320x240:r=30:d=${d}[bg];color=c=0x909090:s=320x240:r=30:d=${d}[lit];` +
      `color=c=white:s=60x60:r=30:d=${d}[box];` +
      `[bg][lit]overlay=enable='lt(mod(t-0.05\\,2)\\,0.12)*gte(t\\,1.05)*lt(t\\,20)'[c];` +
      `[c][box]overlay=x='${clapX}':y=80`,
    ...H264,
    path.join(dir, 'camera.mp4'),
  ]);
  // Mic: beeps 20 ms late; a 30 ms noise burst at 22.39 s + 1.5 k (10 ms before contact).
  ff([
    '-f',
    'lavfi',
    '-i',
    `aevalsrc='0.5*sin(2*PI*1000*t)*lt(mod(t-0.02\\,2)\\,0.12)*gte(t\\,1.02)*lt(t\\,20)` +
      `+0.8*(random(0)*2-1)*gte(t\\,22)*lt(mod(t-22.39\\,1.5)\\,0.03)':s=48000:d=${d}`,
    ...OPUS,
    path.join(dir, 'microphone.mp4'),
  ]);
  // System audio: beeps 10 ms early.
  ff([
    '-f',
    'lavfi',
    '-i',
    `aevalsrc='0.5*sin(2*PI*1000*t)*lt(mod(t+0.01\\,2)\\,0.12)*gte(t\\,0.99)*lt(t\\,20)':s=48000:d=${d}`,
    '-ac',
    '2',
    ...OPUS,
    path.join(dir, 'system-audio.mp4'),
  ]);
  await fs.writeFile(
    path.join(project, 'project.json'),
    JSON.stringify({
      media: [
        media('screen', 'video', 'screen.mp4'),
        media('camera', 'video', 'camera.mp4'),
        media('microphone', 'audio', 'microphone.mp4'),
        media('system-audio', 'audio', 'system-audio.mp4'),
      ],
    }),
  );
}, 60_000);

afterAll(async () => {
  if (work) await fs.rm(work, { recursive: true, force: true });
});

describe('sync analyzer on a synthetic recording', () => {
  it('measures each stream against the screen flashes, per window and from claps', () => {
    const report = analyzeProject(project, { clapWindow: [21, 30], windowS: 10 });
    expect(report.flashes).toBe(9);
    const offset = (role: string) => report.offsets[role]?.summary?.medianMs ?? NaN;
    expect(offset('microphone')).toBeCloseTo(20, -1); // ±5 ms
    expect(Math.abs(offset('microphone') - 20)).toBeLessThanOrEqual(5);
    expect(Math.abs(offset('system-audio') + 10)).toBeLessThanOrEqual(5);
    // Camera frames are 33 ms apart: within one frame of the true 50 ms.
    expect(Math.abs(offset('camera') - 50)).toBeLessThanOrEqual(34);
    expect(report.cameraMic.method).toBe('flash');

    // Claps at 22.4 s + 1.5 k (6 up to 30 s), all seen; camera − mic is 10 ms (plus at most one
    // frame).
    expect(report.clap?.claps).toBe(6);
    expect(report.clap?.pairs.length).toBeGreaterThanOrEqual(5);
    const clap = report.clap?.summary?.medianMs ?? NaN;
    expect(clap).toBeGreaterThanOrEqual(10 - 5);
    expect(clap).toBeLessThanOrEqual(10 + 34);

    // Per-window offsets over the flashing part (flashes at 2–8 s, then 10–18 s).
    const windows = report.windows.microphone ?? [];
    expect(windows.slice(0, 2).map((w) => w.pairs)).toEqual([4, 5]);
    for (const w of windows.slice(0, 2)) expect(Math.abs((w.medianMs ?? NaN) - 20)).toBeLessThan(5);
  }, 60_000);

  it('applies the project media mapping (start offset and clock ratio)', async () => {
    const doc = JSON.parse(await fs.readFile(path.join(project, 'project.json'), 'utf8')) as {
      media: { role: string; startOffsetUs: number }[];
    };
    const shifted = path.join(work, 'Shifted.cstudio');
    await fs.cp(project, shifted, { recursive: true });
    for (const m of doc.media) if (m.role === 'microphone') m.startOffsetUs = -15_000;
    await fs.writeFile(path.join(shifted, 'project.json'), JSON.stringify(doc));
    const report = analyzeProject(shifted);
    const mic = report.offsets.microphone?.summary?.medianMs ?? NaN;
    expect(Math.abs(mic - 5)).toBeLessThanOrEqual(5);
  }, 60_000);

  it('measures flash versus beep in an exported file', () => {
    const exported = path.join(work, 'export.mp4');
    ff([
      '-i',
      path.join(project, 'media', 'screen.mp4'),
      '-i',
      path.join(project, 'media', 'microphone.mp4'),
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      exported,
    ]);
    const result = analyzeExport(exported);
    expect(result.flashes).toBe(9);
    expect(Math.abs((result.summary?.medianMs ?? NaN) - 20)).toBeLessThanOrEqual(5);
  }, 60_000);

  it('detects the pause mode (red frames, 3 kHz tone) only where present', () => {
    const red = path.join(work, 'red.mp4');
    ff([
      '-f',
      'lavfi',
      '-i',
      `color=c=black:s=160x90:r=30:d=4[bg];color=c=red:s=160x90:r=30:d=4[r];[bg][r]overlay=enable='between(t\\,1\\,2)'`,
      ...H264,
      red,
    ]);
    const frames = redFrames(videoStats(red));
    expect(frames.length).toBeGreaterThanOrEqual(29);
    expect(Math.min(...frames)).toBeGreaterThanOrEqual(0.99);
    expect(redFrames(videoStats(path.join(project, 'media', 'screen.mp4')))).toEqual([]);

    const tone = path.join(work, 'tone.mp4');
    ff([
      '-f',
      'lavfi',
      '-i',
      `aevalsrc='0.5*sin(2*PI*1000*t)*lt(mod(t\\,2)\\,0.12)+0.3*sin(2*PI*3000*t)*between(t\\,3\\,4)':s=48000:d=6`,
      ...OPUS,
      tone,
    ]);
    const spans = pauseToneSpans(tone);
    expect(spans).toHaveLength(1);
    expect(Math.abs((spans[0]?.startS ?? 0) - 3)).toBeLessThan(0.05);
    expect(Math.abs((spans[0]?.endS ?? 0) - 4)).toBeLessThan(0.05);
    // Beeps and broadband noise bursts (claps) are not the pause tone.
    expect(pauseToneSpans(path.join(project, 'media', 'microphone.mp4'))).toEqual([]);
  }, 60_000);
});
