/**
 * Property tests (fast-check, §4.6.1) for the recording pipeline's pure parts: the drift fit,
 * the initial timeline built from a recording, and the recording state machine.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  transition,
  type RecordingEvent,
  type RecordingState,
} from '../../src/main/recording/state-machine';
import {
  activeIntervals,
  normalizePauses,
  projectFromRecording,
  type RecordedStream,
  type RecordingManifest,
} from '../../src/shared/project/from-recording';
import { mediaRefBounds } from '../../src/shared/project/media-time';
import { fitClockRatio, type Checkpoint } from '../../src/shared/recording/drift';

const S = 1_000_000;

describe('drift fit (properties)', () => {
  it('recovers any plausible drift from clean checkpoints within 0.5 ppm', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 25, max: 900, noNaN: true }),
        fc.boolean(),
        fc.integer({ min: 0, max: 2 ** 40 }),
        (ppm, negative, startUs) => {
          const ratio = 1 + ((negative ? -1 : 1) * ppm) / 1e6;
          const points: Checkpoint[] = Array.from({ length: 300 }, (_, i) => [
            Math.round(startUs + i * S * ratio),
            i * 48_000,
          ]);
          const fit = fitClockRatio(points, 48_000);
          expect(fit.decision).toBe('applied');
          expect(Math.abs(fit.clockRatio - ratio) * 1e6).toBeLessThan(0.5);
        },
      ),
    );
  });

  it('is unaffected by a constant shift of the session clock (cross-process offsets)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -3000, max: 3000 }), { minLength: 30, maxLength: 120 }),
        fc.integer({ min: -(2 ** 45), max: 2 ** 45 }),
        (jitter, shift) => {
          const points: Checkpoint[] = jitter.map((j, i) => [i * S + j, i * 48_000]);
          const shifted: Checkpoint[] = points.map(([t, n]) => [t + shift, n]);
          const a = fitClockRatio(points, 48_000);
          const b = fitClockRatio(shifted, 48_000);
          expect(b.decision).toBe(a.decision);
          expect(Math.abs(a.fittedRatio - b.fittedRatio) * 1e6).toBeLessThan(1e-3);
        },
      ),
    );
  });

  it('is shift-invariant with drift and mostly exact points (flat loss minima)', () => {
    // Shrunk counterexample shape of the old fit: most points exactly on the line, a few early.
    const jitterArb = fc.array(
      fc.oneof(fc.constant(0), fc.constant(0), fc.integer({ min: -3000, max: 3000 })),
      { minLength: 30, maxLength: 400 },
    );
    fc.assert(
      fc.property(
        jitterArb,
        fc.integer({ min: -(2 ** 45), max: 2 ** 45 }),
        fc.double({ min: -900, max: 900, noNaN: true }),
        (jitter, shift, ppm) => {
          const ratio = 1 + ppm / 1e6;
          const points: Checkpoint[] = jitter.map((j, i) => [
            Math.round(i * S * ratio) + j,
            i * 48_000,
          ]);
          const a = fitClockRatio(points, 48_000);
          const b = fitClockRatio(
            points.map(([t, n]) => [t + shift, n]),
            48_000,
          );
          expect(b.decision).toBe(a.decision);
          expect(Math.abs(a.fittedRatio - b.fittedRatio) * 1e6).toBeLessThan(1e-3);
          expect(Math.abs(b.interceptUs - a.interceptUs - shift)).toBeLessThan(1);
        },
      ),
      { numRuns: 300 },
    );
  });
});

const pausesArb = fc
  .array(fc.tuple(fc.integer({ min: 0, max: 600 }), fc.integer({ min: 1, max: 60 })), {
    maxLength: 5,
  })
  .map((list) => list.map(([start, len]) => ({ startUs: start * S, endUs: (start + len) * S })));

const offsetArb = fc.integer({ min: 0, max: 400_000 });

function stream(
  role: RecordedStream['role'],
  startOffsetUs: number,
  durationUs: number,
  clockRatio = 1,
): RecordedStream {
  const video = role === 'screen' || role === 'camera';
  return {
    role,
    path: `media/${role}.mp4`,
    status: 'ok',
    durationUs,
    startOffsetUs,
    clockRatio,
    endedEarly: false,
    sync: { mode: video ? 'shared' : 'arrival-calibrated', offsetUs: 0, clockHandshakeUs: null },
    ...(video
      ? {
          video: {
            codec: 'h264',
            width: 1920,
            height: 1080,
            frameRateNominal: 30,
            variableFrameRate: true,
          },
        }
      : { audio: { codec: 'opus', sampleRate: 48_000, channels: 1, discontinuities: 0 } }),
  };
}

describe('projectFromRecording (properties)', () => {
  it('builds a valid project whose clips skip pauses and keep every track in sync', () => {
    fc.assert(
      fc.property(
        pausesArb,
        fc.tuple(offsetArb, offsetArb, offsetArb, offsetArb),
        fc.integer({ min: 20, max: 700 }),
        fc.double({ min: 0.9995, max: 1.0005, noNaN: true }),
        (pauses, [so, co, mo, yo], seconds, ratio) => {
          const durationUs = seconds * S;
          const manifest: RecordingManifest = {
            version: 1,
            projectId: 'prj_PROP',
            name: 'Property',
            createdAt: '2026-10-24T14:05:00.000Z',
            appVersion: '0.1.0',
            recording: {
              state: 'complete',
              sessionId: 'ses_PROP',
              startedAt: '2026-10-24T14:05:00.000Z',
              durationUs,
              pauses,
              source: { kind: 'monitor', widthPx: 1920, heightPx: 1080, region: null },
              platform: { os: 'linux', electron: '45', chromium: '156', ffmpeg: 'n9' },
            },
            frameRate: 30,
            streams: [
              stream('screen', so, durationUs - so),
              stream('camera', co, durationUs - co),
              stream('microphone', mo, Math.floor((durationUs - mo) / ratio), ratio),
              stream('system-audio', yo, durationUs - yo),
            ],
          };
          const result = projectFromRecording(manifest);
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          const project = result.value;
          const normalized = normalizePauses(pauses, durationUs);
          const active = activeIntervals(durationUs, pauses);
          const mediaById = new Map(project.media.map((m) => [m.id, m]));

          for (const track of project.timeline.tracks) {
            for (const clip of track.clips) {
              // Never inside a pause, always inside an active interval and the media bounds.
              expect(
                active.some((a) => clip.sourceStartUs >= a.startUs && clip.sourceEndUs <= a.endUs),
              ).toBe(true);
              const bounds = mediaRefBounds(mediaById.get(clip.mediaId)!);
              expect(clip.sourceStartUs).toBeGreaterThanOrEqual(bounds.startUs);
              expect(clip.sourceEndUs).toBeLessThanOrEqual(bounds.endUs);
              // Sync: the timeline position is the session time minus the pauses before it.
              const pausedBefore = normalized
                .filter((p) => p.endUs <= clip.sourceStartUs)
                .reduce((sum, p) => sum + (p.endUs - p.startUs), 0);
              expect(clip.timelineStartUs).toBe(clip.sourceStartUs - pausedBefore);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

const EVENT_ARB: fc.Arbitrary<RecordingEvent> = fc.oneof(
  fc.constant({ type: 'configure' } as const),
  fc.constant({ type: 'dismiss' } as const),
  fc.constant({ type: 'record' } as const),
  fc.constant({ type: 'portal-cancelled' } as const),
  fc.boolean().map((region) => ({ type: 'tracks-ready', region }) as const),
  fc.constant({ type: 'region-picked' } as const),
  fc.constant({ type: 'cancel' } as const),
  fc.constant({ type: 'countdown-elapsed' } as const),
  fc.constant({ type: 'pause' } as const),
  fc.constant({ type: 'resume' } as const),
  fc
    .constantFrom('stop', 'screen-ended', 'disk-low')
    .map((reason) => ({ type: 'stop', reason }) as const),
  fc.constant({ type: 'restart' } as const),
  fc.constant({ type: 'abort' } as const),
  fc.constant({ type: 'finalized' } as const),
  fc.constant({ type: 'error', reason: 'x' } as const),
);

describe('recording state machine (properties)', () => {
  it('only reaches recording through a countdown, and finalizes only captured sessions', () => {
    fc.assert(
      fc.property(fc.array(EVENT_ARB, { maxLength: 60 }), (events) => {
        let state: RecordingState = 'idle';
        for (const event of events) {
          const next = transition(state, event);
          if (!next) continue;
          const previous = state;
          state = next.to;
          if (state === 'recording') expect(['countdown', 'paused']).toContain(previous);
          if (state === 'finalizing') expect(['recording', 'paused']).toContain(previous);
          if (state === 'completed') expect(previous).toBe('finalizing');
          // Deleting the folder is only ever asked for on abort.
          if (next.effects.includes('delete-project')) expect(event.type).toBe('abort');
        }
      }),
    );
  });
});
