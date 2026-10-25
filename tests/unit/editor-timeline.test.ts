/**
 * Timeline UI logic (step 17; R1.34, R1.36, R1.39, R1.44): time ↔ pixel mapping, zoom, hit
 * testing, drags with snapping, waveform folding and thumbnail lookup.
 */
import { describe, expect, it } from 'vitest';
import { beginClipDrag, dragOp } from '../../src/renderer/editor/Timeline/drag';
import {
  MAX_PX_PER_SEC,
  MIN_PX_PER_SEC,
  RULER_HEIGHT,
  clampScroll,
  fitView,
  hitTest,
  layoutRows,
  revealTime,
  rulerTicks,
  snapThresholdUs,
  timeToX,
  xToTime,
  zoomAround,
} from '../../src/renderer/editor/Timeline/geometry';
import { thumbCell } from '../../src/renderer/editor/Timeline/thumbnails';
import { columnPeaks, parsePeaks } from '../../src/renderer/editor/Timeline/waveform';
import { applyOp, clipEndUs } from '../../src/shared/project/timeline-ops';
import { unwrap } from '../../src/shared/result';
import { recordedProject, trackByName } from '../fixtures/editor-project';

const S = 1_000_000;

describe('time ↔ pixels and zoom', () => {
  it('maps time to x and back', () => {
    const view = { pxPerSec: 100, scrollUs: 2 * S };
    expect(timeToX(view, 3 * S)).toBe(100);
    expect(xToTime(view, 100)).toBe(3 * S);
    expect(xToTime(view, timeToX(view, 7_654_321))).toBe(7_654_321);
  });

  it('zooms around the pointer, keeping the time under it', () => {
    const view = { pxPerSec: 50, scrollUs: 10 * S };
    const anchorUs = xToTime(view, 300);
    const zoomed = zoomAround(view, 2, 300);
    expect(zoomed.pxPerSec).toBe(100);
    expect(Math.abs(xToTime(zoomed, 300) - anchorUs)).toBeLessThanOrEqual(1);
    expect(zoomAround(view, 1e9, 0).pxPerSec).toBe(MAX_PX_PER_SEC);
    expect(zoomAround(view, 1e-9, 0).pxPerSec).toBe(MIN_PX_PER_SEC);
    expect(zoomAround({ pxPerSec: 50, scrollUs: 0 }, 0.5, 400).scrollUs).toBe(0);
  });

  it('fits the whole timeline and keeps the scroll in range', () => {
    const fit = fitView(600 * S, 1224);
    expect(timeToX(fit, 600 * S)).toBeLessThanOrEqual(1224);
    expect(timeToX(fit, 600 * S)).toBeGreaterThan(1150);
    expect(clampScroll({ pxPerSec: 10, scrollUs: -5 }, 60 * S, 600).scrollUs).toBe(0);
    expect(clampScroll({ pxPerSec: 10, scrollUs: 999 * S }, 60 * S, 600).scrollUs).toBe(30 * S);
    expect(revealTime({ pxPerSec: 10, scrollUs: 0 }, 5 * S, 600).scrollUs).toBe(0);
    expect(revealTime({ pxPerSec: 10, scrollUs: 0 }, 100 * S, 600).scrollUs).toBe(94 * S);
    expect(snapThresholdUs({ pxPerSec: 80, scrollUs: 0 })).toBe(100_000);
  });

  it('labels ruler ticks at least 90 px apart', () => {
    const ticks = rulerTicks({ pxPerSec: 40, scrollUs: 0 }, 800);
    const majors = ticks.filter((t) => t.major).map((t) => t.tUs);
    expect(majors.slice(0, 3)).toEqual([0, 5 * S, 10 * S]);
    expect(ticks.length).toBeGreaterThan(majors.length);
  });
});

describe('hit testing', () => {
  const doc = recordedProject();
  const { rows } = layoutRows(doc);
  const view = { pxPerSec: 20, scrollUs: 0 };

  it('lays out rows in track order below the ruler', () => {
    expect(rows.map((r) => r.track.name)).toEqual(['Screen', 'Face', 'Voice', 'System audio']);
    expect(rows[0]!.top).toBeGreaterThan(RULER_HEIGHT);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.top).toBeGreaterThanOrEqual(rows[i - 1]!.top + rows[i - 1]!.height);
    }
  });

  it('finds the ruler, clip bodies, clip edges and empty track space', () => {
    expect(hitTest(rows, view, 100, 5)).toEqual({ kind: 'ruler', tUs: 5 * S });
    const face = rows.find((r) => r.track.name === 'Face')!;
    const first = face.track.clips[0]!;
    const second = face.track.clips[1]!;
    const y = face.top + face.height / 2;
    const mid = timeToX(view, first.timelineStartUs + 5 * S);
    expect(hitTest(rows, view, mid, y)).toMatchObject({
      kind: 'clip',
      clipId: first.id,
      zone: 'body',
    });
    const end = timeToX(view, clipEndUs(first));
    expect(hitTest(rows, view, end - 2, y)).toMatchObject({ clipId: first.id, zone: 'end' });
    const start2 = timeToX(view, second.timelineStartUs);
    // Pauses are left out, so the clips touch: each side of the cut grabs its own clip.
    expect(start2).toBe(end);
    expect(hitTest(rows, view, start2 + 2, y)).toMatchObject({ clipId: second.id, zone: 'start' });
    expect(hitTest(rows, view, start2 - 2, y)).toMatchObject({ clipId: first.id, zone: 'end' });
    const afterX = timeToX(view, clipEndUs(face.track.clips.at(-1)!)) + 50;
    expect(hitTest(rows, view, afterX, y)).toMatchObject({ kind: 'track', trackId: face.track.id });
    expect(hitTest(rows, view, 10, 10_000)).toMatchObject({ kind: 'none' });
  });
});

describe('clip drags (R1.36, R1.39)', () => {
  const options = { includeLinked: true, snapping: true, thresholdUs: 200_000, playheadUs: 30 * S };

  it('moves a clip by the pointer delta and snaps its edges to the playhead', () => {
    const doc = recordedProject();
    const clip = trackByName(doc, 'Face').clips[1]!;
    const drag = beginClipDrag(doc, clip.id, 'body', 30 * S)!;
    expect(drag.kind).toBe('move');
    const free = dragOp(doc, drag, 31 * S, { ...options, snapping: false })!;
    expect(free.op).toMatchObject({
      type: 'move',
      toStartUs: clip.timelineStartUs + S,
      onOverlap: 'nearest-free',
    });
    // 30.1 s from the playhead: the start snaps onto it.
    const offset = 30 * S + 100_000 - clip.timelineStartUs;
    const snapped = dragOp(doc, drag, 30 * S + offset, options)!;
    expect(snapped.snappedUs).toBe(30 * S);
    expect(snapped.op).toMatchObject({ toStartUs: 30 * S });
    const next = unwrap(applyOp(doc, snapped.op));
    // The linked Voice clip moved with it.
    expect(trackByName(next, 'Voice').clips[1]!.timelineStartUs).toBe(30 * S);
  });

  it('trims an edge, snapping to clip edges on other tracks, and Alt leaves the partner', () => {
    const doc = recordedProject();
    const clip = trackByName(doc, 'Face').clips[0]!;
    const drag = beginClipDrag(doc, clip.id, 'end', clipEndUs(clip))!;
    const screenEnd = clipEndUs(trackByName(doc, 'Screen').clips[0]!);
    const result = dragOp(doc, drag, screenEnd - 2 * S + 150_000, { ...options, playheadUs: 0 })!;
    expect(result.op).toMatchObject({ type: 'trim', edge: 'end', includeLinked: true });
    const alt = dragOp(doc, drag, clipEndUs(clip) - 3 * S, { ...options, includeLinked: false })!;
    const next = unwrap(applyOp(doc, alt.op));
    expect(clipEndUs(trackByName(next, 'Face').clips[0]!)).toBe(clipEndUs(clip) - 3 * S);
    expect(clipEndUs(trackByName(next, 'Voice').clips[0]!)).toBe(clipEndUs(clip));
  });
});

describe('waveforms and thumbnails (R1.44)', () => {
  it('folds 10 ms peak pairs into pixel columns', () => {
    const bytes = new ArrayBuffer(8 * 4);
    const view = new DataView(bytes);
    // 8 pairs: [−i·1000, i·1000]
    for (let i = 0; i < 8; i++) {
      view.setInt16(i * 4, -i * 1000, true);
      view.setInt16(i * 4 + 2, i * 1000, true);
    }
    const peaks = parsePeaks(bytes);
    expect(Array.from(peaks.slice(0, 4))).toEqual([0, 0, -1000, 1000]);
    const columns = columnPeaks(peaks, 0, 80_000, 2); // 40 ms each
    expect(columns[0]).toBeCloseTo(-3000 / 32768, 6);
    expect(columns[1]).toBeCloseTo(3000 / 32767, 6);
    expect(columns[3]).toBeCloseTo(7000 / 32767, 6);
    expect(Array.from(columnPeaks(peaks, 200_000, 300_000, 2))).toEqual([0, 0, 0, 0]);
  });

  it('finds the thumbnail cell nearest a file time', () => {
    const index = {
      version: 1 as const,
      mediaId: 'med_x',
      intervalUs: 2 * S,
      tileWidth: 160,
      tileHeight: 90,
      columns: 10,
      rows: 10,
      count: 150,
      sheets: ['a.jpg', 'b.jpg'],
    };
    expect(thumbCell(index, 0)).toEqual({ sheet: 0, sx: 0, sy: 0, sw: 160, sh: 90 });
    expect(thumbCell(index, 25 * S)).toEqual({ sheet: 0, sx: 160 * 3, sy: 90, sw: 160, sh: 90 });
    expect(thumbCell(index, 210 * S)).toMatchObject({ sheet: 1, sx: 5 * 160, sy: 0 });
    expect(thumbCell(index, 9_999 * S)).toMatchObject({ sheet: 1, sx: 9 * 160, sy: 4 * 90 });
    expect(thumbCell({ ...index, count: 0 }, 0)).toBeNull();
  });
});
