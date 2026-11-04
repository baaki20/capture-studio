/**
 * Preview instrumentation (§4.6.4): late-frame counters of the preview client and audio
 * underruns of the scheduler's chunk plan.
 */
import { describe, expect, it } from 'vitest';
import { chunkLatenessS, START_SLACK_S } from '../../src/renderer/editor/audio/schedule-math';
import { PlaybackCounters } from '../../src/renderer/editor/preview/playback-counters';
import {
  DISPLAY_FRAME_MS,
  MAX_LEAD_MS,
  RenderLatency,
} from '../../src/renderer/editor/preview/render-latency';

const S = 1_000_000;

describe('PlaybackCounters', () => {
  it('counts superseded and stand-in frames while playing as late', () => {
    const c = new PlaybackCounters();
    c.request(true, false); // sent
    c.request(true, false); // waits
    c.request(true, true); // replaces the waiting one
    c.drawn(true, true);
    c.drawn(true, false); // drawn with a stand-in
    c.request(false, false); // a scrub, not counted
    c.drawn(false, false); // a re-render, not counted
    expect(c.snapshot()).toEqual({ requested: 3, superseded: 1, drawn: 2, inexact: 1, late: 2 });
    c.reset();
    expect(c.snapshot().late).toBe(0);
  });
});

describe('RenderLatency (preview render-ahead, R1.24)', () => {
  it('is zero until a frame is timed, then the median plus one display frame', () => {
    const l = new RenderLatency();
    expect(l.leadUs()).toBe(0);
    for (const ms of [30, 35, 40, 500, 32]) l.sample(ms); // one stall
    expect(l.leadUs()).toBe(Math.round((35 + DISPLAY_FRAME_MS) * 1000));
  });

  it('follows recent frames, ignores bad samples and is capped', () => {
    const l = new RenderLatency();
    for (let i = 0; i < 40; i++) l.sample(10);
    for (let i = 0; i < 31; i++) l.sample(60);
    l.sample(-1);
    l.sample(Number.NaN);
    expect(l.leadUs()).toBe(Math.round((60 + DISPLAY_FRAME_MS) * 1000));
    for (let i = 0; i < 31; i++) l.sample(2_000);
    expect(l.leadUs()).toBe(MAX_LEAD_MS * 1000);
    l.reset();
    expect(l.leadUs()).toBe(0);
  });
});

describe('chunkLatenessS (audio underruns)', () => {
  const segment = {
    timelineStartUs: 10 * S,
    timelineEndUs: 20 * S,
    fileStartSeconds: 2,
    fileEndSeconds: 12,
    clockRatio: 1,
  };
  // Timeline 10 s is heard at context time 50 s.
  const anchor = { timelineUs: 10 * S, contextTime: 50, rate: 1 };

  it('is zero for a chunk scheduled ahead of time', () => {
    expect(chunkLatenessS(segment, { fileStartUs: 3 * S, fileEndUs: 4 * S }, anchor, 49)).toBe(0);
  });

  it('measures how late a chunk starts', () => {
    // File 3 s → timeline 11 s → context 51 s; now is 51.25 s.
    const late = chunkLatenessS(segment, { fileStartUs: 3 * S, fileEndUs: 4 * S }, anchor, 51.25);
    expect(late).toBeCloseTo(0.25 - START_SLACK_S, 6);
  });

  it('never counts the part before the playhead', () => {
    // Playback starts mid-chunk: file 2.5 s is at the anchor (context 50.12 s after the delay).
    const startAnchor = { timelineUs: 10.5 * S, contextTime: 50.12, rate: 1 };
    expect(chunkLatenessS(segment, { fileStartUs: 2 * S, fileEndUs: 3 * S }, startAnchor, 50)).toBe(
      0,
    );
  });

  it('ignores chunks outside the segment and reverse playback', () => {
    expect(chunkLatenessS(segment, { fileStartUs: 0, fileEndUs: 1 * S }, anchor, 60)).toBe(0);
    expect(
      chunkLatenessS(
        segment,
        { fileStartUs: 3 * S, fileEndUs: 4 * S },
        { ...anchor, rate: -2 },
        60,
      ),
    ).toBe(0);
  });
});
