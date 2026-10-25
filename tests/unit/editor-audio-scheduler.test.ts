/**
 * Preview audio maths (§4.3.8, step 16): the master clock, chunk planning with clock ratios and
 * late starts, chunk merging, gains after mute/solo, and the transport driven by a fake clock.
 */
import { describe, expect, it } from 'vitest';
import {
  ChunkAccumulator,
  contextTimeFor,
  planChunk,
  scheduleSignature,
  segmentFileAt,
  segmentTimelineAt,
  timelineAt,
  trackGains,
  type ScheduledSegment,
} from '../../src/renderer/editor/audio/schedule-math';
import { Playback, type PlaybackClock } from '../../src/renderer/editor/playback';
import { createDocumentStore } from '../../src/renderer/editor/store/document-store';
import { createUiStore } from '../../src/renderer/editor/ui-store';
import { audioSegments } from '../../src/shared/project/render-plan';
import { applyOp, timelineDurationUs } from '../../src/shared/project/timeline-ops';
import { unwrap } from '../../src/shared/result';
import { exampleProject } from '../fixtures/example-project';

const S = 1_000_000;

describe('master clock', () => {
  it('maps context time to timeline time and back at any rate', () => {
    const anchor = { timelineUs: 10 * S, contextTime: 100, rate: 1 };
    expect(timelineAt(anchor, 100)).toBe(10 * S);
    expect(timelineAt(anchor, 101.5)).toBe(11.5 * S);
    expect(contextTimeFor(anchor, 12 * S)).toBe(102);
    const fast = { ...anchor, rate: 2 };
    expect(timelineAt(fast, 101)).toBe(12 * S);
    expect(contextTimeFor(fast, 12 * S)).toBe(101);
    const reverse = { ...anchor, rate: -2 };
    expect(timelineAt(reverse, 101)).toBe(8 * S);
  });
});

describe('planChunk', () => {
  // A mic segment: timeline [5 s, 15 s) plays file [2 s, …) with a drift ratio.
  const segment: ScheduledSegment = {
    timelineStartUs: 5 * S,
    timelineEndUs: 15 * S,
    fileStartSeconds: 2,
    fileEndSeconds: 2 + 10 / 1.0001,
    clockRatio: 1.0001,
  };
  const anchor = { timelineUs: 5 * S, contextTime: 50, rate: 1 };

  it('maps file and timeline time through the clock ratio', () => {
    expect(segmentTimelineAt(segment, 3 * S)).toBeCloseTo(5 * S + 1.0001 * S, 3);
    expect(segmentFileAt(segment, segmentTimelineAt(segment, 3.5 * S))).toBeCloseTo(3.5 * S, 3);
  });

  it('schedules a chunk at its timeline position with playbackRate = 1 / clockRatio', () => {
    const plan = planChunk(segment, { fileStartUs: 3 * S, fileEndUs: 4 * S }, anchor, 49)!;
    expect(plan.when).toBeCloseTo(50 + 1.0001, 6);
    expect(plan.offset).toBe(0);
    expect(plan.duration).toBeCloseTo(1, 9);
    expect(plan.playbackRate).toBeCloseTo(1 / 1.0001, 12);
  });

  it('clips a chunk to the segment and starts it mid-buffer when the segment starts inside it', () => {
    const plan = planChunk(segment, { fileStartUs: 1.5 * S, fileEndUs: 2.5 * S }, anchor, 49)!;
    expect(plan.when).toBeCloseTo(50, 9);
    expect(plan.offset).toBeCloseTo(0.5, 9);
    expect(plan.duration).toBeCloseTo(0.5, 9);
    expect(planChunk(segment, { fileStartUs: 0, fileEndUs: 1 * S }, anchor, 49)).toBeNull();
  });

  it('skips into a late chunk and drops one that is over', () => {
    const plan = planChunk(segment, { fileStartUs: 2 * S, fileEndUs: 3 * S }, anchor, 50.4)!;
    expect(plan.when).toBe(50.4);
    expect(plan.offset).toBeCloseTo(0.4 / 1.0001, 6);
    expect(plan.duration).toBeCloseTo(1 - 0.4 / 1.0001, 6);
    expect(planChunk(segment, { fileStartUs: 2 * S, fileEndUs: 3 * S }, anchor, 52)).toBeNull();
  });

  it('doubles the playback rate when shuttling at 2× and plays nothing in reverse', () => {
    const fast = { ...anchor, rate: 2 };
    const plan = planChunk(segment, { fileStartUs: 3 * S, fileEndUs: 4 * S }, fast, 49)!;
    expect(plan.playbackRate).toBeCloseTo(2 / 1.0001, 9);
    expect(plan.when).toBeCloseTo(50 + 1.0001 / 2, 6);
    expect(
      planChunk(segment, { fileStartUs: 3 * S, fileEndUs: 4 * S }, { ...anchor, rate: -2 }, 49),
    ).toBeNull();
  });
});

describe('ChunkAccumulator', () => {
  const piece = (timestampUs: number, frames: number, channels = 1, sampleRate = 48_000) => ({
    timestampUs,
    sampleRate,
    channels: Array.from({ length: channels }, (_, c) => new Float32Array(frames).fill(c + 1)),
  });

  it('merges 20 ms pieces into about 1 s chunks', () => {
    const acc = new ChunkAccumulator();
    const out = [];
    for (let i = 0; i < 60; i++) out.push(...acc.push(piece(i * 20_000, 960)));
    const rest = acc.flush();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ fileStartUs: 0, fileEndUs: 1 * S, sampleRate: 48_000 });
    expect(out[0]!.channels[0]).toHaveLength(48_000);
    expect(rest).toMatchObject({ fileStartUs: 1 * S, fileEndUs: 1.2 * S });
  });

  it('ends a chunk early at a gap or a format change, keeping chunks contiguous', () => {
    const acc = new ChunkAccumulator();
    expect(acc.push(piece(0, 960, 2))).toEqual([]);
    const gap = acc.push(piece(100_000, 960, 2));
    expect(gap).toHaveLength(1);
    expect(gap[0]).toMatchObject({ fileStartUs: 0, fileEndUs: 20_000 });
    expect(gap[0]!.channels[1]![0]).toBe(2);
    const format = acc.push(piece(120_000, 960, 1));
    expect(format[0]).toMatchObject({ fileStartUs: 100_000, fileEndUs: 120_000 });
    expect(acc.flush()?.channels).toHaveLength(1);
    expect(acc.flush()).toBeNull();
  });
});

describe('gains and rescheduling', () => {
  const edit = (doc = exampleProject(), ...ops: Parameters<typeof applyOp>[1][]) =>
    ops.reduce((d, op) => unwrap(applyOp(d, op)), doc);

  it('applies gain, mute and solo like the render plan', () => {
    const doc = edit(exampleProject(), { type: 'setGain', trackId: 'trk_v', gainDb: -6 });
    expect(trackGains(doc).get('trk_v')).toBeCloseTo(10 ** (-6 / 20), 9);
    const system = doc.timeline.tracks.find((t) => t.id === 'trk_y')!;
    const systemGain = system.type === 'audio' ? 10 ** (system.gainDb / 20) : NaN;
    expect(trackGains(doc).get('trk_y')).toBeCloseTo(systemGain, 12);
    const muted = edit(doc, { type: 'setMuted', trackId: 'trk_v', muted: true });
    expect(trackGains(muted).get('trk_v')).toBe(0);
    const solo = edit(doc, { type: 'setSolo', trackId: 'trk_y', solo: true });
    expect(trackGains(solo).get('trk_v')).toBe(0);
    expect(trackGains(solo).get('trk_y')).toBeCloseTo(systemGain, 12);
    for (const seg of audioSegments(solo, { includeInaudible: true })) {
      expect(trackGains(solo).get(seg.trackId)).toBeCloseTo(seg.linearGain, 12);
    }
  });

  it('reschedules for structural edits and nudges, not for gain-only edits', () => {
    const doc = exampleProject();
    const urls = { med_m: 'cs-media://p/m', med_y: 'cs-media://p/y' };
    const base = scheduleSignature(doc, urls);
    expect(
      scheduleSignature(edit(doc, { type: 'setGain', trackId: 'trk_v', gainDb: -3 }), urls),
    ).toBe(base);
    expect(
      scheduleSignature(edit(doc, { type: 'setMuted', trackId: 'trk_v', muted: true }), urls),
    ).toBe(base);
    expect(
      scheduleSignature(
        edit(doc, { type: 'nudge', target: { componentId: 'cmp_face' }, syncAdjustUs: 30_000 }),
        urls,
      ),
    ).not.toBe(base);
    expect(scheduleSignature(edit(doc, { type: 'split', atUs: 60 * S }), urls)).not.toBe(base);
  });
});

describe('Playback (transport)', () => {
  function setup() {
    const docStore = createDocumentStore();
    docStore
      .getState()
      .load({ doc: exampleProject(), revision: 0, mediaUrls: {}, readOnly: false });
    const ui = createUiStore();
    let heard: number | null = null;
    const starts: [number, number][] = [];
    const clock: PlaybackClock = {
      start: (from, rate) => {
        starts.push([from, rate]);
        heard = from;
      },
      stop: () => {
        heard = null;
      },
      heardTimeUs: () => heard,
    };
    const renders: [number, boolean][] = [];
    const frames: (() => void)[] = [];
    const playback = new Playback({
      docStore,
      ui,
      clock,
      preview: { render: (t, playing) => renders.push([t, playing]) },
      requestFrame: (cb) => frames.push(cb),
      cancelFrame: () => undefined,
    });
    const advance = (t: number) => {
      heard = t;
      frames.shift()?.();
    };
    return { docStore, ui, playback, starts, renders, advance };
  }

  it('plays from the playhead, follows the clock and stops at the end', () => {
    const { ui, playback, starts, renders, advance, docStore } = setup();
    ui.getState().setPlayhead(5 * S);
    playback.toggle();
    expect(starts).toEqual([[5 * S, 1]]);
    expect(ui.getState()).toMatchObject({ playing: true, rate: 1 });
    advance(6 * S);
    expect(ui.getState().playheadUs).toBe(6 * S);
    expect(renders.at(-1)).toEqual([6 * S, true]);
    const end = timelineDurationUs(docStore.getState().doc!);
    advance(end + 1);
    expect(ui.getState()).toMatchObject({ playing: false, playheadUs: end });
  });

  it('shuttles at ±2×, pauses with K, steps frames and renders paused seeks', () => {
    const { ui, playback, starts, renders } = setup();
    ui.getState().setPlayhead(10 * S);
    playback.shuttle(1);
    expect(starts.at(-1)).toEqual([10 * S, 2]);
    playback.shuttle(0);
    expect(ui.getState().playing).toBe(false);
    playback.shuttle(-1);
    expect(starts.at(-1)).toEqual([10 * S, -2]);
    playback.pause();
    playback.step(1);
    expect(ui.getState().playheadUs).toBe(10 * S + 33_333);
    playback.step(-2);
    expect(ui.getState().playheadUs).toBe(10 * S - 33_333);
    expect(renders.at(-1)).toEqual([10 * S - 33_333, false]);
    playback.home();
    expect(ui.getState().playheadUs).toBe(0);
  });
});
