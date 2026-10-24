/**
 * Sync analyzer (§4.5 step 20, R1.24). Finds the flash/beep events of tests/sync/pattern in each
 * stream of a recorded project, maps them onto the session clock with the project's own media
 * mapping (`fileToRefUs`: start offset, sync adjust, clockRatio) and reports each stream's
 * offset from the screen, and how that offset changes over the recording (residual drift).
 *
 * Run: npx tsx tests/sync/analyze.ts "<project>.cstudio"
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileToRefUs, type MediaClock } from '../../src/shared/project/media-time';

const FFMPEG = resolve(import.meta.dirname, '../../resources/bin/linux-x64/ffmpeg');
const TONE_HZ = 1000;
const MIN_GAP_S = 1.0;

interface Media extends MediaClock {
  id: string;
  role: string;
  kind: 'video' | 'audio';
  path: string;
}

function ffmpeg(args: string[], binary = false): Buffer {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-nostats', ...args], {
    maxBuffer: 1 << 30,
    encoding: binary ? 'buffer' : undefined,
  });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${String(r.stderr).slice(-500)}`);
  return Buffer.from(r.stdout);
}

function percentile(values: readonly number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))] ?? NaN;
}

/** Rising edges of `values` above `threshold`, at least MIN_GAP_S apart. */
function onsets(times: readonly number[], values: readonly number[], threshold: number): number[] {
  const out: number[] = [];
  let above = true; // ignore a stream that starts mid-flash
  for (let i = 0; i < values.length; i++) {
    const v = values[i] ?? 0;
    const t = times[i] ?? 0;
    if (!above && v > threshold && (out.length === 0 || t - (out.at(-1) ?? 0) > MIN_GAP_S)) {
      out.push(t);
    }
    above = v > threshold;
  }
  return out;
}

/** Frame brightness (mean luma) per frame, by pts. */
function videoEvents(file: string, role: string): number[] {
  const text = ffmpeg([
    '-i',
    file,
    '-an',
    '-vf',
    'scale=64:36,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-',
    '-f',
    'null',
    '-',
  ]).toString();
  const times: number[] = [];
  const luma: number[] = [];
  let pts = NaN;
  for (const line of text.split('\n')) {
    const m = /pts_time:([\d.]+)/.exec(line);
    if (m) pts = Number(m[1]);
    const y = /YAVG=([\d.]+)/.exec(line);
    if (y && Number.isFinite(pts)) {
      times.push(pts);
      luma.push(Number(y[1]));
    }
  }
  if (role === 'screen') {
    // The flash fills the screen with white: threshold halfway between dark and white.
    return onsets(times, luma, (percentile(luma, 0.05) + percentile(luma, 0.995)) / 2);
  }
  // Camera: the flash lights the face. Use the rise over the previous 0.5 s minimum.
  const rise = luma.map((v, i) => {
    let lo = v;
    for (let j = i - 1; j >= 0 && (times[i] ?? 0) - (times[j] ?? 0) < 0.5; j--) {
      lo = Math.min(lo, luma[j] ?? lo);
    }
    return v - lo;
  });
  return onsets(times, rise, Math.max(3, 0.5 * percentile(rise, 0.99)));
}

/** 1 kHz tone energy (Goertzel, 10 ms windows, 2.5 ms hop). */
function audioEvents(file: string): number[] {
  const rate = 16_000;
  const raw = ffmpeg(
    ['-i', file, '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', '-'],
    true,
  );
  const pcm = new Int16Array(raw.buffer, raw.byteOffset, raw.length / 2);
  const win = rate / 100;
  const hop = rate / 400;
  const k = 2 * Math.cos((2 * Math.PI * TONE_HZ) / rate);
  const times: number[] = [];
  const energy: number[] = [];
  for (let start = 0; start + win <= pcm.length; start += hop) {
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < win; i++) {
      const s0 = (pcm[start + i] ?? 0) / 32768 + k * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    times.push(start / rate);
    energy.push(s1 * s1 + s2 * s2 - k * s1 * s2);
  }
  const loud = percentile(energy, 0.999);
  const floor = percentile(energy, 0.5);
  return onsets(times, energy, floor + 0.2 * (loud - floor));
}

function fitPpm(xs: readonly number[], ys: readonly number[]): number {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += ((xs[i] ?? 0) - mx) ** 2;
    sxy += ((xs[i] ?? 0) - mx) * ((ys[i] ?? 0) - my);
  }
  return sxx === 0 ? NaN : (sxy / sxx) * 1e6;
}

function main(): void {
  const dir = process.argv[2];
  if (!dir) throw new Error('usage: tsx tests/sync/analyze.ts <project>.cstudio');
  const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as { media: Media[] };
  const events = new Map<string, number[]>();
  for (const media of project.media) {
    const file = join(dir, media.path);
    const fileSeconds = media.kind === 'video' ? videoEvents(file, media.role) : audioEvents(file);
    // Session-clock seconds via the project's own mapping.
    events.set(
      media.role,
      fileSeconds.map((s) => fileToRefUs(media, s * 1e6) / 1e6),
    );
    const ratio =
      media.clockRatio === 1
        ? ''
        : ` (clockRatio ${((media.clockRatio - 1) * 1e6).toFixed(1)} ppm)`;
    console.log(
      `${media.role.padEnd(13)} ${String(fileSeconds.length).padStart(4)} events${ratio}`,
    );
  }
  const screen = events.get('screen') ?? [];
  if (screen.length < 5) throw new Error('fewer than 5 flashes found on the screen track');
  console.log(
    `\noffset from screen (ms; positive = later than the flash); ${String(screen.length)} flashes over ${((screen.at(-1) ?? 0) - (screen[0] ?? 0)).toFixed(0)} s`,
  );
  console.log('stream         pairs  median    p10    p90   first⅓  last⅓  trend ppm');
  for (const [role, list] of events) {
    if (role === 'screen') continue;
    const xs: number[] = [];
    const ds: number[] = [];
    for (const t of screen) {
      let best = NaN;
      for (const e of list)
        if (Math.abs(e - t) < 0.4 && !(Math.abs(best - t) <= Math.abs(e - t))) best = e;
      if (Number.isFinite(best)) {
        xs.push(t);
        ds.push((best - t) * 1000);
      }
    }
    if (ds.length < 3) {
      console.log(
        `${role.padEnd(13)} ${String(ds.length).padStart(5)}  (not enough matched events)`,
      );
      continue;
    }
    const third = Math.max(1, Math.floor(ds.length / 3));
    const f = (v: number) => v.toFixed(1).padStart(7);
    console.log(
      `${role.padEnd(13)} ${String(ds.length).padStart(5)} ${f(percentile(ds, 0.5))}${f(percentile(ds, 0.1))}${f(percentile(ds, 0.9))}${f(percentile(ds.slice(0, third), 0.5))}${f(percentile(ds.slice(-third), 0.5))}${f(
        fitPpm(
          xs,
          ds.map((d) => d / 1000),
        ),
      )}`,
    );
  }
}

main();
