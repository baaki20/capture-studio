/**
 * The gain envelope of an audio track over the timeline (v2, R2.12, R2.13, R2.16; D5): what
 * multiplies its audio besides the track's own gain, mute and solo.
 *
 *   envelope(t) = clip gain × clip fades × volume keyframes × ducking
 *
 * - **Clip gain** is the clip's `gainDb`; **fades** ramp the amplitude linearly from 0 over
 *   `fadeInUs` and back to 0 over `fadeOutUs`.
 * - **Volume keyframes** add dB, eased in dB (`volume-keyframes.ts`).
 * - **Ducking** (D5, not `sidechaincompress`): wherever the voice track this track ducks under
 *   has sound (its waveform peaks above `DUCK_THRESHOLD_DB`), the track goes down by `amountDb`,
 *   moving there over `attackMs` and back over `releaseMs`. It is computed from the peaks, so the
 *   preview and the export apply the same curve.
 *
 * The result is a list of breakpoints with linear interpolation of the amplitude between them,
 * thinned where a straight line is within `TOLERANCE_DB`. The export applies it with timed
 * `volume` commands, the preview as gain automation. Pure; peaks come from the caller.
 */
import type { Us } from '../time';
import { clipTimelineDurationUs } from './clip-time';
import { PEAK_WINDOW_US } from './peaks';
import { audioSegments, dbToLinear } from './render-plan';
import type { AudioTrack, Project } from './schema';
import { volumeDbAt } from './volume-keyframes';

/** A point of the envelope: amplitude factor `gain` at `tUs`, linear in between. */
export interface GainPoint {
  tUs: Us;
  gain: number;
}

/** Louder than this (peak, dBFS) counts as the voice speaking. */
export const DUCK_THRESHOLD_DB = -40;
/** Sampling step of eased volume changes and ducking. */
export const ENVELOPE_STEP_US = 10_000;
/** Breakpoints closer than this to a straight line between their neighbours are dropped. */
export const TOLERANCE_DB = 0.1;

/** Peaks of a media (pairs of min, max per 10 ms window), or null when not loaded. */
export type PeaksOf = (mediaId: string) => Int16Array | null;

function linearToDb(gain: number): number {
  return 20 * Math.log10(Math.max(gain, 1e-6));
}

/** Clip gain × fades at `tUs` (1 outside clips). */
function clipFactor(track: AudioTrack, tUs: Us): number {
  for (const clip of track.clips) {
    const start = clip.timelineStartUs;
    const end = start + clipTimelineDurationUs(clip);
    if (tUs < start || tUs >= end) continue;
    let f = clip.gainDb ? dbToLinear(clip.gainDb) : 1;
    if (clip.fadeInUs) f *= Math.min(1, (tUs - start) / clip.fadeInUs);
    if (clip.fadeOutUs) f *= Math.min(1, (end - tUs) / clip.fadeOutUs);
    return f;
  }
  return 1;
}

/** Times where the clip factor has corners: clip edges and fade ends. */
function clipCorners(track: AudioTrack): Us[] {
  const out: Us[] = [];
  for (const clip of track.clips) {
    const start = clip.timelineStartUs;
    const end = start + clipTimelineDurationUs(clip);
    out.push(start, end - 1);
    if (clip.fadeInUs) out.push(start + clip.fadeInUs);
    if (clip.fadeOutUs) out.push(end - clip.fadeOutUs);
  }
  return out;
}

/**
 * Whether the voice track has sound in each `ENVELOPE_STEP_US` step of `[0, durationUs)`, from
 * its media's peaks; null when a voice clip's peaks are not loaded (no ducking then).
 */
function voiceActivity(
  doc: Project,
  voiceTrackId: string,
  durationUs: Us,
  peaksOf: PeaksOf,
): Uint8Array | null {
  const steps = Math.ceil(durationUs / ENVELOPE_STEP_US);
  const active = new Uint8Array(steps);
  const limit = 32768 * 10 ** (DUCK_THRESHOLD_DB / 20);
  for (const s of audioSegments(doc, { includeInaudible: true })) {
    if (s.trackId !== voiceTrackId || s.offline) continue;
    const peaks = peaksOf(s.mediaId);
    if (!peaks) return null;
    const first = Math.floor(s.timelineStartUs / ENVELOPE_STEP_US);
    const last = Math.min(steps, Math.ceil(s.timelineEndUs / ENVELOPE_STEP_US));
    for (let i = first; i < last; i++) {
      const t = i * ENVELOPE_STEP_US;
      const fileUs =
        s.fileStartSeconds * 1_000_000 + ((t - s.timelineStartUs) * s.speed) / s.clockRatio;
      const w = Math.floor(fileUs / PEAK_WINDOW_US);
      const min = peaks[w * 2] ?? 0;
      const max = peaks[w * 2 + 1] ?? 0;
      if (Math.max(-min, max) > limit) active[i] = 1;
    }
  }
  return active;
}

/** Ducking in dB at each step: toward `amountDb` while the voice speaks, with attack/release. */
function duckCurve(
  active: Uint8Array,
  duck: NonNullable<NonNullable<AudioTrack['cleanup']>['duck']>,
): Float32Array {
  const out = new Float32Array(active.length);
  const stepMs = ENVELOPE_STEP_US / 1000;
  const down = (duck.amountDb * stepMs) / duck.attackMs;
  const up = (-duck.amountDb * stepMs) / duck.releaseMs;
  let db = 0;
  for (let i = 0; i < active.length; i++) {
    db = active[i] ? Math.max(duck.amountDb, db + down) : Math.min(0, db + up);
    out[i] = db;
  }
  return out;
}

/** Drops points within `TOLERANCE_DB` of the straight line through their kept neighbours. */
export function simplify(points: readonly GainPoint[]): GainPoint[] {
  const first = points[0];
  const lastPoint = points[points.length - 1];
  if (points.length <= 2 || !first || !lastPoint) return [...points];
  const out: GainPoint[] = [first];
  let kept = first;
  for (let i = 1; i < points.length - 1; i++) {
    const b = points[i];
    const c = points[i + 1];
    if (!b || !c) continue;
    const along = (b.tUs - kept.tUs) / Math.max(1, c.tUs - kept.tUs);
    const line = kept.gain + (c.gain - kept.gain) * along;
    if (Math.abs(linearToDb(line) - linearToDb(b.gain)) > TOLERANCE_DB) {
      out.push(b);
      kept = b;
    }
  }
  out.push(lastPoint);
  return out;
}

/**
 * The envelope of audio track `trackId` over the timeline, or null when it is 1 throughout (no
 * clip gain, fades, volume keyframes or ducking): the Phase 1 case.
 */
export function trackEnvelope(
  doc: Project,
  trackId: string,
  peaksOf: PeaksOf = () => null,
  durationUs?: Us,
): GainPoint[] | null {
  const track = doc.timeline.tracks.find((t) => t.id === trackId);
  if (track?.type !== 'audio') return null;
  const end =
    durationUs ??
    Math.max(
      0,
      ...doc.timeline.tracks.flatMap((t) =>
        t.clips.map((c) => c.timelineStartUs + clipTimelineDurationUs(c)),
      ),
    );
  const hasClipGain = track.clips.some(
    (c) => (c.gainDb ?? 0) !== 0 || (c.fadeInUs ?? 0) > 0 || (c.fadeOutUs ?? 0) > 0,
  );
  const keys = track.volumeKeyframes;
  const duck = track.cleanup?.duck;
  const activity = duck ? voiceActivity(doc, duck.byTrackId, end, peaksOf) : null;
  if (!hasClipGain && (keys?.length ?? 0) === 0 && !activity) return null;

  const times = new Set<Us>([0, end]);
  for (const t of clipCorners(track)) if (t >= 0 && t <= end) times.add(t);
  if (keys?.length) {
    keys.forEach((k, i) => {
      const next = keys[i + 1];
      times.add(k.tUs);
      if (k.easing === 'hold' && next) times.add(next.tUs - 1);
      else if (next && k.easing !== 'linear') {
        for (let t = k.tUs; t < next.tUs; t += ENVELOPE_STEP_US) times.add(t);
      } else if (next) {
        // dB is linear in time; the amplitude is not: sample it.
        for (let t = k.tUs; t < next.tUs; t += ENVELOPE_STEP_US * 5) times.add(t);
      }
    });
  }
  const curve = activity && duck ? duckCurve(activity, duck) : null;
  if (curve) for (let i = 0; i < curve.length; i++) times.add(i * ENVELOPE_STEP_US);

  const points = [...times]
    .filter((t) => t >= 0 && t <= end)
    .sort((a, b) => a - b)
    .map((tUs) => {
      const step = Math.min(curve ? curve.length - 1 : 0, Math.floor(tUs / ENVELOPE_STEP_US));
      const duckDb = curve ? (curve[step] ?? 0) : 0;
      const gain = clipFactor(track, tUs) * dbToLinear(volumeDbAt(keys, tUs) + duckDb);
      return { tUs, gain };
    });
  return simplify(points);
}

/** The envelope's value at `tUs` (linear between points; the ends hold). */
export function gainAt(points: readonly GainPoint[], tUs: Us): number {
  let previous: GainPoint | undefined;
  for (const point of points) {
    if (tUs <= point.tUs) {
      if (!previous) return point.gain;
      const span = Math.max(1, point.tUs - previous.tUs);
      return previous.gain + ((point.gain - previous.gain) * (tUs - previous.tUs)) / span;
    }
    previous = point;
  }
  return previous?.gain ?? 1;
}
