import { describe, expect, it } from 'vitest';
import {
  AudioContinuity,
  type AudioOp,
  type ChunkPlan,
} from '../../src/shared/recording/audio-continuity';

const RATE = 48_000;
const CHUNK = 1024;
const CHUNK_US = (CHUNK * 1_000_000) / RATE; // 21333.33 µs

function chunkTime(i: number, startUs = 1_000_000): number {
  return Math.round(startUs + i * CHUNK_US);
}

function framesOf(ops: AudioOp[], type: AudioOp['type']): number {
  return ops
    .filter((op) => op.type === type)
    .reduce((n, op) => n + (op.type === 'copy' ? op.toFrame - op.fromFrame : op.frames), 0);
}

describe('audio continuity', () => {
  it('writes contiguous chunks unchanged', () => {
    const c = new AudioContinuity({ sampleRate: RATE });
    for (let i = 0; i < 100; i++) {
      const plan = c.plan({ timeUs: chunkTime(i), frames: CHUNK });
      expect(plan.ops).toEqual([{ type: 'copy', fromFrame: 0, toFrame: CHUNK }]);
      expect(plan.discontinuity).toBeNull();
    }
    expect(c.startUs).toBe(1_000_000);
    expect(c.framesWritten).toBe(100 * CHUNK);
    expect(c.discontinuities).toBe(0);
  });

  it('absorbs timestamp jitter up to 50 ms', () => {
    const c = new AudioContinuity({ sampleRate: RATE });
    c.plan({ timeUs: chunkTime(0), frames: CHUNK });
    expect(c.plan({ timeUs: chunkTime(1) + 45_000, frames: CHUNK }).discontinuity).toBeNull();
    expect(c.plan({ timeUs: chunkTime(2) - 45_000, frames: CHUNK }).discontinuity).toBeNull();
    expect(c.framesWritten).toBe(3 * CHUNK);
    expect(c.discontinuities).toBe(0);
  });

  it('fills a gap over 50 ms with exact-length silence', () => {
    const c = new AudioContinuity({ sampleRate: RATE });
    c.plan({ timeUs: chunkTime(0), frames: CHUNK });
    // The next chunk arrives 100 ms late (a device hiccup).
    const plan = c.plan({ timeUs: chunkTime(1) + 100_000, frames: CHUNK });
    expect(plan.discontinuity).toEqual({ kind: 'gap', frames: 4800, us: 100_000 });
    expect(plan.ops).toEqual([
      { type: 'silence', frames: 4800, cause: 'gap' },
      { type: 'copy', fromFrame: 0, toFrame: CHUNK },
    ]);
    expect(c.framesWritten).toBe(2 * CHUNK + 4800);
    expect(c.endUs).toBe(chunkTime(2) + 100_000);
    expect(c.discontinuities).toBe(1);
  });

  it('splits long silences into pieces of at most 1 s', () => {
    const c = new AudioContinuity({ sampleRate: RATE });
    c.plan({ timeUs: 0, frames: CHUNK });
    const plan = c.plan({ timeUs: Math.round(CHUNK_US) + 2_500_000, frames: CHUNK });
    expect(plan.ops.map((op) => (op.type === 'silence' ? op.frames : -1))).toEqual([
      48_000, 48_000, 24_000, -1,
    ]);
  });

  it('drops the overlapping part of a chunk over 50 ms early', () => {
    const c = new AudioContinuity({ sampleRate: RATE });
    for (let i = 0; i < 10; i++) c.plan({ timeUs: chunkTime(i), frames: CHUNK });
    // A chunk that claims to start 60 ms before the stream's end (a timestamp step back).
    const end = c.endUs!;
    const plan = c.plan({ timeUs: end - 60_000, frames: 4800 });
    expect(plan.discontinuity?.kind).toBe('overlap');
    expect(plan.ops).toEqual([{ type: 'copy', fromFrame: 2880, toFrame: 4800 }]);
    expect(plan.dropped).toBe(false);
    expect(c.endUs).toBe(end + 40_000);
    // A chunk entirely inside the written range is dropped.
    const dup: ChunkPlan = c.plan({ timeUs: chunkTime(3), frames: CHUNK });
    expect(dup.dropped).toBe(true);
    expect(dup.ops).toEqual([]);
    expect(c.discontinuities).toBe(2);
  });

  it('replaces paused audio with the same number of silent frames', () => {
    const c = new AudioContinuity({ sampleRate: RATE });
    const ops: AudioOp[] = [];
    let input = 0;
    const pauseAt = 1_500_000;
    const resumeAt = 2_750_000;
    for (let i = 0; i < 150; i++) {
      const t = chunkTime(i, 0);
      if (t <= pauseAt && t + CHUNK_US > pauseAt) c.pause(pauseAt);
      if (t <= resumeAt && t + CHUNK_US > resumeAt) c.resume(resumeAt);
      const plan = c.plan({ timeUs: t, frames: CHUNK });
      // While paused, no frame of the chunk's paused part is copied.
      for (const op of plan.ops) {
        if (op.type !== 'copy') continue;
        const from = t + (op.fromFrame * 1_000_000) / RATE;
        const to = t + (op.toFrame * 1_000_000) / RATE;
        expect(to <= pauseAt + 21 || from >= resumeAt - 21).toBe(true);
      }
      ops.push(...plan.ops);
      input += CHUNK;
    }
    // The stream stays linear: as many frames out as in.
    expect(c.framesWritten).toBe(input);
    expect(framesOf(ops, 'silence')).toBe(Math.round(((resumeAt - pauseAt) * RATE) / 1_000_000));
    expect(c.discontinuities).toBe(0);
    expect(c.paused).toBe(false);
  });

  it('gates on session time, which may be in a different domain from the media time', () => {
    const c = new AudioContinuity({ sampleRate: RATE });
    // Media timestamps start near 0; session time is 20.5 s ahead (spike S2).
    c.pause(20_500_000 + 1_000_000);
    const plan = c.plan({ timeUs: 990_000, sessionUs: 20_500_000 + 990_000, frames: 960 });
    expect(plan.ops).toEqual([
      { type: 'copy', fromFrame: 0, toFrame: 480 },
      { type: 'silence', frames: 480, cause: 'pause' },
    ]);
    c.resume(20_500_000 + 1_010_000);
    const next = c.plan({ timeUs: 1_010_000, sessionUs: 20_500_000 + 1_010_000, frames: 960 });
    expect(next.ops).toEqual([{ type: 'copy', fromFrame: 0, toFrame: 960 }]);
  });

  it('handles a gap during a pause: silence for both', () => {
    const c = new AudioContinuity({ sampleRate: RATE });
    c.plan({ timeUs: 0, frames: 4800 });
    c.pause(100_000);
    const plan = c.plan({ timeUs: 200_000, frames: 4800 });
    expect(plan.discontinuity?.kind).toBe('gap');
    expect(plan.ops).toEqual([
      { type: 'silence', frames: 4800, cause: 'gap' },
      { type: 'silence', frames: 4800, cause: 'pause' },
    ]);
  });

  it('ignores repeated pause and resume calls', () => {
    const c = new AudioContinuity({ sampleRate: RATE });
    c.resume(5);
    c.pause(10);
    c.pause(20);
    expect(c.paused).toBe(true);
    c.resume(30);
    c.resume(40);
    expect(c.paused).toBe(false);
    expect(() => new AudioContinuity({ sampleRate: 0 })).toThrow(RangeError);
  });
});
