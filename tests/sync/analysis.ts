/**
 * Sync analysis (§4.5 step 20, §4.6.5; R1.14, R1.24): event detection in recorded media and the
 * offsets between streams, used by `analyze.ts` (command line), the Wayland harness and tests.
 * It reads media files only (no editor or preview involved).
 *
 * - **Flashes** (tests/sync/pattern): the screen's mean luma jumps to white; on the camera the
 *   flash lights the room (or shows in a mirror), detected as a rise over the previous 0.5 s.
 * - **Beeps:** 1 kHz tone energy (Goertzel, 10 ms windows, 2.5 ms hop).
 * - **Claps** (camera ↔ mic fallback when the camera cannot see the flash): the mic's
 *   broadband transient (energy above 3 kHz, where the 1 kHz beep is filtered out) paired with
 *   the camera frame where the hands' motion energy falls most steeply (they stop at contact).
 * - Every event is mapped onto the session clock with the project's own media mapping
 *   (`fileToRefUs`: start offset, sync adjust, clock ratio), so offsets measure the project as
 *   the editor and export will play it.
 * - **Drift over long runs:** offsets are also reported per time window (e.g. 60 s), and at any
 *   instant (`offsetNear`), so a 30-minute run reads the offset at 30 minutes directly.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileToRefUs, type MediaClock } from '../../src/shared/project/media-time';

export const FFMPEG = resolve(
  import.meta.dirname,
  '../../resources/bin',
  `${process.platform}-${process.arch}`,
  'ffmpeg',
);
export const TONE_HZ = 1000;
/** The pattern's pause-mode tone (R1.14 check): must never appear in recorded media. */
export const PAUSE_TONE_HZ = 3000;
const MIN_GAP_S = 1.0;
const AUDIO_RATE = 16_000;

export interface ProjectMedia extends MediaClock {
  id: string;
  role: string;
  kind: 'video' | 'audio';
  path: string;
  endedEarly?: boolean;
}

export interface ProjectDoc {
  media: ProjectMedia[];
  recording?: {
    durationUs?: number;
    pauses?: { startUs: number; endUs: number }[];
    state?: string;
  };
}

export interface Series {
  times: number[];
  values: number[];
}

export interface VideoStats {
  times: number[];
  y: number[];
  u: number[];
  v: number[];
}

function ffmpeg(args: string[], binary = false): Buffer {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-nostats', ...args], {
    maxBuffer: 1 << 30,
    encoding: binary ? 'buffer' : undefined,
  });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${String(r.stderr).slice(-500)}`);
  return Buffer.from(r.stdout);
}

/** Optional input trim, in file seconds. */
export interface Range {
  fromS?: number;
  toS?: number;
}

function inputArgs(file: string, range: Range = {}): string[] {
  return [
    ...(range.fromS !== undefined ? ['-ss', String(Math.max(0, range.fromS))] : []),
    ...(range.toS !== undefined ? ['-to', String(range.toS)] : []),
    '-copyts',
    '-i',
    file,
  ];
}

export function percentile(values: readonly number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))] ?? NaN;
}

/** Rising edges of `values` above `threshold`, at least `minGapS` apart. */
export function onsets(
  times: readonly number[],
  values: readonly number[],
  threshold: number,
  minGapS = MIN_GAP_S,
): number[] {
  const out: number[] = [];
  let above = true; // ignore a stream that starts mid-event
  for (let i = 0; i < values.length; i++) {
    const v = values[i] ?? 0;
    const t = times[i] ?? 0;
    if (!above && v > threshold && (out.length === 0 || t - (out.at(-1) ?? 0) > minGapS)) {
      out.push(t);
    }
    above = v > threshold;
  }
  return out;
}

/** Mean Y, U and V per frame (64×36 downscale), by pts in file seconds. */
export function videoStats(file: string, range?: Range): VideoStats {
  const text = ffmpeg([
    ...inputArgs(file, range),
    '-an',
    '-vf',
    'scale=64:36,signalstats,metadata=print:file=-',
    '-f',
    'null',
    '-',
  ]).toString();
  const out: VideoStats = { times: [], y: [], u: [], v: [] };
  let pts = NaN;
  let y = NaN;
  let u = NaN;
  const flush = (v: number) => {
    if (Number.isFinite(pts) && Number.isFinite(y)) {
      out.times.push(pts);
      out.y.push(y);
      out.u.push(u);
      out.v.push(v);
    }
  };
  for (const line of text.split('\n')) {
    const m = /pts_time:([\d.]+)/.exec(line);
    if (m) {
      pts = Number(m[1]);
      y = NaN;
      u = NaN;
      continue;
    }
    const kv = /lavfi\.signalstats\.(YAVG|UAVG|VAVG)=([\d.]+)/.exec(line);
    if (!kv) continue;
    if (kv[1] === 'YAVG') y = Number(kv[2]);
    else if (kv[1] === 'UAVG') u = Number(kv[2]);
    else flush(Number(kv[2]));
  }
  return out;
}

/** Frame-to-frame motion energy (mean absolute luma difference, 160×90). */
export function motionSeries(file: string, range?: Range): Series {
  const text = ffmpeg([
    ...inputArgs(file, range),
    '-an',
    '-vf',
    'scale=160:90,format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-',
    '-f',
    'null',
    '-',
  ]).toString();
  const times: number[] = [];
  const values: number[] = [];
  let pts = NaN;
  for (const line of text.split('\n')) {
    const m = /pts_time:([\d.]+)/.exec(line);
    if (m) pts = Number(m[1]);
    const y = /YAVG=([\d.]+)/.exec(line);
    if (y && Number.isFinite(pts)) {
      times.push(pts);
      values.push(Number(y[1]));
    }
  }
  return { times, values };
}

/** Flash onsets in a video's luma (file seconds). `screen`: the frame turns white. */
export function flashEvents(stats: Pick<VideoStats, 'times' | 'y'>, role: string): number[] {
  const { times, y: luma } = stats;
  if (luma.length === 0) return [];
  if (role === 'screen') {
    // The flash fills the screen with white: threshold halfway between dark and white.
    return onsets(times, luma, (percentile(luma, 0.05) + percentile(luma, 0.995)) / 2);
  }
  // Camera: the flash lights the room. Use the rise over the previous 0.5 s minimum.
  const rise = luma.map((v, i) => {
    let lo = v;
    for (let j = i - 1; j >= 0 && (times[i] ?? 0) - (times[j] ?? 0) < 0.5; j--) {
      lo = Math.min(lo, luma[j] ?? lo);
    }
    return v - lo;
  });
  return onsets(times, rise, Math.max(3, 0.5 * percentile(rise, 0.99)));
}

/** Mono 16 kHz PCM of a file's audio. */
export function decodeAudio(file: string, range?: Range): { pcm: Float32Array; startS: number } {
  const raw = ffmpeg(
    [...inputArgs(file, range), '-vn', '-ac', '1', '-ar', String(AUDIO_RATE), '-f', 's16le', '-'],
    true,
  );
  const ints = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 2));
  const pcm = new Float32Array(ints.length);
  for (let i = 0; i < ints.length; i++) pcm[i] = (ints[i] ?? 0) / 32768;
  return { pcm, startS: range?.fromS ?? 0 };
}

/** Tone energy at `hz` (Goertzel, 10 ms windows, 2.5 ms hop), by file seconds (window centre). */
export function toneEnergy(pcm: Float32Array, startS: number, hz: number): Series {
  const win = AUDIO_RATE / 100;
  const hop = AUDIO_RATE / 400;
  const k = 2 * Math.cos((2 * Math.PI * hz) / AUDIO_RATE);
  const times: number[] = [];
  const values: number[] = [];
  for (let start = 0; start + win <= pcm.length; start += hop) {
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < win; i++) {
      const s0 = (pcm[start + i] ?? 0) + k * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    // Each window is stamped at its centre, so onsets are not biased early.
    times.push(startS + (start + win / 2) / AUDIO_RATE);
    values.push((s1 * s1 + s2 * s2 - k * s1 * s2) / (win * win));
  }
  return { times, values };
}

/** Beep onsets in a tone-energy series. */
export function beepEvents(energy: Series): number[] {
  const loud = percentile(energy.values, 0.999);
  const floor = percentile(energy.values, 0.5);
  return onsets(energy.times, energy.values, floor + 0.2 * (loud - floor));
}

/** RBJ high-pass biquad, applied twice (24 dB/octave) at `cutoffHz`. */
export function highPass(pcm: Float32Array, cutoffHz: number): Float32Array {
  const w0 = (2 * Math.PI * cutoffHz) / AUDIO_RATE;
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const cos = Math.cos(w0);
  const a0 = 1 + alpha;
  const b0 = (1 + cos) / 2 / a0;
  const b1 = -(1 + cos) / a0;
  const b2 = b0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  let out = pcm;
  for (let pass = 0; pass < 2; pass++) {
    const input = out;
    out = new Float32Array(input.length);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < input.length; i++) {
      const x0 = input[i] ?? 0;
      const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      out[i] = y0;
      x2 = x1;
      x1 = x0;
      y2 = y1;
      y1 = y0;
    }
  }
  return out;
}

/** Broadband transient energy above 3 kHz (5 ms windows, 2.5 ms hop), by file seconds. */
export function transientEnergy(pcm: Float32Array, startS: number): Series {
  const hp = highPass(pcm, 3_000);
  const win = AUDIO_RATE / 200;
  const hop = AUDIO_RATE / 400;
  const times: number[] = [];
  const values: number[] = [];
  for (let start = 0; start + win <= hp.length; start += hop) {
    let sum = 0;
    for (let i = 0; i < win; i++) sum += (hp[start + i] ?? 0) ** 2;
    times.push(startS + (start + win / 2) / AUDIO_RATE);
    values.push(sum / win);
  }
  return { times, values };
}

/** Clap onsets: transients well above the noise floor, at least 0.5 s apart. */
export function clapOnsets(transients: Series): number[] {
  const loud = percentile(transients.values, 0.999);
  const floor = percentile(transients.values, 0.5);
  return onsets(transients.times, transients.values, floor + 0.3 * (loud - floor), 0.5);
}

/**
 * The visual clap instant near `audioS` (both in session seconds). Motion energy at frame i is
 * the change since frame i−1; where it falls most steeply (within ±`searchS`), nothing moved
 * between i−1 and i, so the hands had met by frame i−1: that frame's time is the estimate (it
 * is late by up to one frame interval). Null without a clear stop.
 */
export function visualClapNear(motion: Series, audioS: number, searchS = 0.35): number | null {
  let best: number | null = null;
  let steepest = 0;
  for (let i = 1; i < motion.values.length; i++) {
    const t = motion.times[i] ?? 0;
    if (Math.abs(t - audioS) > searchS) continue;
    const fall = (motion.values[i - 1] ?? 0) - (motion.values[i] ?? 0);
    if (fall > steepest) {
      steepest = fall;
      best = motion.times[i - 1] ?? t;
    }
  }
  const peak = Math.max(0, ...motion.values);
  return best !== null && steepest >= 0.2 * peak ? best : null;
}

export interface OffsetPair {
  /** Reference event, session seconds. */
  t: number;
  /** Other stream's event minus the reference, ms (positive = later). */
  offsetMs: number;
}

/** Pairs each reference event with the nearest event within `maxS`. */
export function matchOffsets(
  reference: readonly number[],
  events: readonly number[],
  maxS = 0.4,
): OffsetPair[] {
  const out: OffsetPair[] = [];
  for (const t of reference) {
    let best = NaN;
    for (const e of events) {
      if (Math.abs(e - t) < maxS && !(Math.abs(best - t) <= Math.abs(e - t))) best = e;
    }
    if (Number.isFinite(best)) out.push({ t, offsetMs: (best - t) * 1000 });
  }
  return out;
}

export function fitPpm(xs: readonly number[], ys: readonly number[]): number {
  const n = xs.length;
  if (n < 2) return NaN;
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

export interface OffsetSummary {
  pairs: number;
  medianMs: number;
  p10Ms: number;
  p90Ms: number;
  /** Median over the first and last third of the pairs. */
  firstMs: number;
  lastMs: number;
  /** Linear trend of the offset, ppm (residual drift). */
  trendPpm: number;
}

export function summarize(pairs: readonly OffsetPair[]): OffsetSummary | null {
  if (pairs.length < 3) return null;
  const ds = pairs.map((p) => p.offsetMs);
  const third = Math.max(1, Math.floor(ds.length / 3));
  return {
    pairs: pairs.length,
    medianMs: percentile(ds, 0.5),
    p10Ms: percentile(ds, 0.1),
    p90Ms: percentile(ds, 0.9),
    firstMs: percentile(ds.slice(0, third), 0.5),
    lastMs: percentile(ds.slice(-third), 0.5),
    trendPpm: fitPpm(
      pairs.map((p) => p.t),
      ds.map((d) => d / 1000),
    ),
  };
}

export interface OffsetWindow {
  startS: number;
  endS: number;
  pairs: number;
  medianMs: number | null;
}

/** Median offset per window of `windowS` seconds of session time (drift over long runs). */
export function windowedOffsets(pairs: readonly OffsetPair[], windowS: number): OffsetWindow[] {
  if (pairs.length === 0) return [];
  const first = Math.floor((pairs[0]?.t ?? 0) / windowS);
  const last = Math.floor((pairs.at(-1)?.t ?? 0) / windowS);
  const out: OffsetWindow[] = [];
  for (let w = first; w <= last; w++) {
    const inside = pairs.filter((p) => p.t >= w * windowS && p.t < (w + 1) * windowS);
    out.push({
      startS: w * windowS,
      endS: (w + 1) * windowS,
      pairs: inside.length,
      medianMs: inside.length
        ? percentile(
            inside.map((p) => p.offsetMs),
            0.5,
          )
        : null,
    });
  }
  return out;
}

/** Median offset of the pairs within ±`halfWidthS` of `atS` (e.g. the offset at 30 minutes). */
export function offsetNear(
  pairs: readonly OffsetPair[],
  atS: number,
  halfWidthS = 60,
): { medianMs: number; pairs: number } | null {
  const near = pairs.filter((p) => Math.abs(p.t - atS) <= halfWidthS).map((p) => p.offsetMs);
  return near.length >= 3 ? { medianMs: percentile(near, 0.5), pairs: near.length } : null;
}

// ---------------------------------------------------------------------------------------------
// Whole projects and exported files

export interface StreamEvents {
  role: string;
  kind: 'video' | 'audio';
  /** Session seconds. */
  events: number[];
  clockRatioPpm: number;
}

export interface ClapResult {
  /** Audio clap onsets found in the window (session seconds). */
  claps: number;
  /** Camera minus mic, per clap. */
  pairs: OffsetPair[];
  summary: OffsetSummary | null;
}

export interface ProjectSyncReport {
  root: string;
  flashes: number;
  spanS: number;
  streams: StreamEvents[];
  /** Offset of each stream from the screen flashes. */
  offsets: Record<string, { pairs: OffsetPair[]; summary: OffsetSummary | null }>;
  windows: Record<string, OffsetWindow[]>;
  /** Camera ↔ mic: from the flashes when the camera saw them, else from claps. */
  cameraMic: {
    method: 'flash' | 'clap' | 'none';
    medianMs: number | null;
    pairs: number;
  };
  clap: ClapResult | null;
}

export interface AnalyzeOptions {
  /** Session seconds of a clap segment (camera ↔ mic fallback). */
  clapWindow?: [number, number];
  /** Drift window length, s (default 60). */
  windowS?: number;
  /** Only events in this session-time range (e.g. after a resume). */
  sessionRange?: [number, number];
}

export function readProject(root: string): ProjectDoc {
  return JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')) as ProjectDoc;
}

const toSession = (media: MediaClock, fileS: number): number =>
  fileToRefUs(media, fileS * 1e6) / 1e6;

const toFile = (media: MediaClock, sessionS: number): number =>
  (sessionS * 1e6 - media.startOffsetUs - media.syncAdjustUs) / media.clockRatio / 1e6;

/** Flash and beep events of every stream of a project, in session seconds. */
export function projectEvents(root: string, doc: ProjectDoc = readProject(root)): StreamEvents[] {
  return doc.media.map((media) => {
    const file = join(root, media.path);
    const fileEvents =
      media.kind === 'video'
        ? flashEvents(videoStats(file), media.role)
        : (() => {
            const { pcm, startS } = decodeAudio(file);
            return beepEvents(toneEnergy(pcm, startS, TONE_HZ));
          })();
    return {
      role: media.role,
      kind: media.kind,
      events: fileEvents.map((s) => toSession(media, s)),
      clockRatioPpm: (media.clockRatio - 1) * 1e6,
    };
  });
}

/** Camera minus mic from claps in a session-time window. */
export function clapOffsets(
  root: string,
  doc: ProjectDoc,
  window: [number, number],
): ClapResult | null {
  const camera = doc.media.find((m) => m.role === 'camera');
  const mic = doc.media.find((m) => m.role === 'microphone' || m.role === 'mic');
  if (!camera || !mic) return null;
  const [from, to] = window;
  const audio = decodeAudio(join(root, mic.path), {
    fromS: Math.max(0, toFile(mic, from)),
    toS: toFile(mic, to),
  });
  const claps = clapOnsets(transientEnergy(audio.pcm, audio.startS)).map((s) => toSession(mic, s));
  const motionFile = motionSeries(join(root, camera.path), {
    fromS: Math.max(0, toFile(camera, from)),
    toS: toFile(camera, to),
  });
  const motion: Series = {
    times: motionFile.times.map((s) => toSession(camera, s)),
    values: motionFile.values,
  };
  const pairs: OffsetPair[] = [];
  for (const a of claps) {
    const v = visualClapNear(motion, a);
    if (v !== null) pairs.push({ t: a, offsetMs: (v - a) * 1000 });
  }
  return { claps: claps.length, pairs, summary: summarize(pairs) };
}

export function analyzeProject(root: string, options: AnalyzeOptions = {}): ProjectSyncReport {
  const doc = readProject(root);
  const inRange = (t: number) =>
    !options.sessionRange || (t >= options.sessionRange[0] && t <= options.sessionRange[1]);
  const streams = projectEvents(root, doc).map((s) => ({ ...s, events: s.events.filter(inRange) }));
  const screen = streams.find((s) => s.role === 'screen')?.events ?? [];
  const offsets: ProjectSyncReport['offsets'] = {};
  const windows: ProjectSyncReport['windows'] = {};
  for (const s of streams) {
    if (s.role === 'screen') continue;
    const pairs = matchOffsets(screen, s.events);
    offsets[s.role] = { pairs, summary: summarize(pairs) };
    windows[s.role] = windowedOffsets(pairs, options.windowS ?? 60);
  }
  const clap = options.clapWindow ? clapOffsets(root, doc, options.clapWindow) : null;
  const cam = offsets.camera?.summary;
  const mic = (offsets.microphone ?? offsets.mic)?.summary;
  let cameraMic: ProjectSyncReport['cameraMic'] = { method: 'none', medianMs: null, pairs: 0 };
  if (cam && mic && cam.pairs >= 5) {
    cameraMic = {
      method: 'flash',
      medianMs: cam.medianMs - mic.medianMs,
      pairs: Math.min(cam.pairs, mic.pairs),
    };
  } else if (clap?.summary) {
    cameraMic = { method: 'clap', medianMs: clap.summary.medianMs, pairs: clap.summary.pairs };
  }
  return {
    root,
    flashes: screen.length,
    spanS: (screen.at(-1) ?? 0) - (screen[0] ?? 0),
    streams,
    offsets,
    windows,
    cameraMic,
    clap,
  };
}

/** Flash (video) versus beep (audio mix) in an exported file (R1.24 "in the exported file"). */
export function analyzeExport(file: string): {
  flashes: number;
  beeps: number;
  pairs: OffsetPair[];
  summary: OffsetSummary | null;
} {
  const flashes = flashEvents(videoStats(file), 'screen');
  const { pcm, startS } = decodeAudio(file);
  const beeps = beepEvents(toneEnergy(pcm, startS, TONE_HZ));
  const pairs = matchOffsets(flashes, beeps);
  return { flashes: flashes.length, beeps: beeps.length, pairs, summary: summarize(pairs) };
}

/**
 * Pause content check (R1.14): spans (file seconds) where the pattern's pause-mode tone is
 * present, i.e. at least `minS` long where the 3 kHz energy stands 10 dB above both neighbouring
 * bands (a tone, not the broadband energy of speech, claps or noise) and above the file's floor.
 */
export function pauseToneSpans(file: string, minS = 0.3): { startS: number; endS: number }[] {
  const { pcm, startS } = decodeAudio(file);
  const tone = toneEnergy(pcm, startS, PAUSE_TONE_HZ);
  const below = toneEnergy(pcm, startS, PAUSE_TONE_HZ - 500).values;
  const above = toneEnergy(pcm, startS, PAUSE_TONE_HZ + 500).values;
  const floor = percentile(tone.values, 0.5);
  const spans: { startS: number; endS: number }[] = [];
  let open: number | null = null;
  for (let i = 0; i <= tone.values.length; i++) {
    const v = tone.values[i];
    const t = tone.times[i] ?? tone.times.at(-1) ?? 0;
    const present =
      v !== undefined &&
      v > 1e-7 &&
      v > 10 * floor &&
      v > 10 * (below[i] ?? 0) &&
      v > 10 * (above[i] ?? 0);
    if (present && open === null) open = t;
    if (!present && open !== null) {
      if (t - open >= minS) spans.push({ startS: open, endS: t });
      open = null;
    }
  }
  return spans;
}

/** Frames whose mean colour is the pattern's pause red (V well above neutral, Y mid). */
export function redFrames(stats: VideoStats): number[] {
  const out: number[] = [];
  for (let i = 0; i < stats.times.length; i++) {
    const v = stats.v[i] ?? 128;
    const u = stats.u[i] ?? 128;
    if (v > 200 && u < 120) out.push(stats.times[i] ?? 0);
  }
  return out;
}

/** Session times of a media's frames (file seconds in) that fall strictly inside `span`. */
export function framesInSpan(
  media: ProjectMedia,
  fileTimes: readonly number[],
  span: [number, number],
): number[] {
  return fileTimes.map((s) => toSession(media, s)).filter((t) => t > span[0] && t < span[1]);
}
