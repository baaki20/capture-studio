import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CLICK_SETTLE_US,
  CursorTrackError,
  clicksShowingAt,
  cursorTrackFromEvents,
  nearestClickDistanceUs,
  parseCursorTrack,
  positionAt,
  rawPositionAt,
  serializeCursorTrack,
  type CursorEvent,
} from '../../src/shared/project/cursor-track';

const header = { sampleRateHz: 120, width: 1920, height: 1080 };

const events: CursorEvent[] = [
  { tUs: 0, x: 100, y: 100 },
  { tUs: 100_000, x: 200, y: 150 },
  { tUs: 200_000, x: 300, y: 200, action: 'down', button: 'left' },
  { tUs: 260_000, x: 300, y: 200, action: 'up', button: 'left' },
  { tUs: 400_000, x: 500, y: 400 },
];

describe('cursor.jsonl', () => {
  it('round-trips through the writer and the parser', () => {
    const track = parseCursorTrack(serializeCursorTrack(header, events));
    expect(track.header).toEqual(header);
    expect(Array.from(track.t)).toEqual([0, 100_000, 200_000, 260_000, 400_000]);
    expect(track.clicks).toEqual([{ tUs: 200_000, x: 300, y: 200, button: 'left', upUs: 260_000 }]);
  });

  it('ignores a partial last line from an abrupt end', () => {
    const text = serializeCursorTrack(header, events) + '[500000, 6';
    expect(parseCursorTrack(text).t).toHaveLength(5);
  });

  it('rejects a damaged file with the line number', () => {
    const lines = serializeCursorTrack(header, events).split('\n');
    lines[2] = '[1, "x", 3]';
    expect(() => parseCursorTrack(lines.join('\n'))).toThrow(/line 3/);
    expect(() => parseCursorTrack('{"format":"other"}\n')).toThrow(CursorTrackError);
    const backwards = serializeCursorTrack(header, [
      { tUs: 10, x: 0, y: 0 },
      { tUs: 5, x: 0, y: 0 },
    ]);
    expect(() => parseCursorTrack(backwards)).toThrow(/decrease/);
  });

  it('keeps a press without a release', () => {
    const track = cursorTrackFromEvents(header, [
      { tUs: 0, x: 1, y: 2, action: 'down', button: 'right' },
    ]);
    expect(track.clicks[0]).toMatchObject({ button: 'right', upUs: null });
  });
});

describe('cursor sampling', () => {
  const track = cursorTrackFromEvents(header, events);

  it('interpolates linearly and holds at the ends', () => {
    expect(rawPositionAt(track, 50_000)).toEqual({ x: 150, y: 125 });
    expect(rawPositionAt(track, -10)).toEqual({ x: 100, y: 100 });
    expect(rawPositionAt(track, 9_000_000)).toEqual({ x: 500, y: 400 });
    expect(rawPositionAt(cursorTrackFromEvents(header, []), 0)).toBeNull();
  });

  it('returns the recorded path without smoothing', () => {
    expect(positionAt(track, 330_000, 0)).toEqual(rawPositionAt(track, 330_000));
  });

  it('rests exactly on a click however smooth', () => {
    expect(positionAt(track, 200_000, 1)).toEqual({ x: 300, y: 200 });
    expect(nearestClickDistanceUs(track, 200_000 + CLICK_SETTLE_US)).toBe(CLICK_SETTLE_US);
  });

  it('smooths a jittery path toward its average', () => {
    const jitter: CursorEvent[] = Array.from({ length: 241 }, (_, i) => ({
      tUs: i * 8_333,
      x: 500 + (i % 2 === 0 ? 10 : -10),
      y: 300,
    }));
    const jittery = cursorTrackFromEvents(header, jitter);
    const p = positionAt(jittery, 1_000_000, 1);
    expect(p?.y).toBeCloseTo(300, 5);
    expect(Math.abs((p?.x ?? 0) - 500)).toBeLessThan(1);
  });

  it('stays inside the bounding box of the path (property)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.integer({ min: 1, max: 50_000 }),
            fc.float({ min: -500, max: 3000, noNaN: true }),
          ),
          {
            minLength: 1,
            maxLength: 40,
          },
        ),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.integer({ min: -100_000, max: 2_100_000 }),
        (steps, smoothing, at) => {
          let t = 0;
          const evs = steps.map(([dt, v]) => ({ tUs: (t += dt), x: v, y: -v }));
          const tr = cursorTrackFromEvents(header, evs);
          const p = positionAt(tr, at, smoothing);
          const xs = Array.from(tr.x);
          expect(p?.x).toBeGreaterThanOrEqual(Math.min(...xs) - 1e-3);
          expect(p?.x).toBeLessThanOrEqual(Math.max(...xs) + 1e-3);
        },
      ),
    );
  });

  it('lists the presses whose ring is showing', () => {
    expect(clicksShowingAt(track, 199_999, 500_000)).toHaveLength(0);
    expect(clicksShowingAt(track, 200_000, 500_000)).toHaveLength(1);
    expect(clicksShowingAt(track, 699_999, 500_000)).toHaveLength(1);
    expect(clicksShowingAt(track, 700_000, 500_000)).toHaveLength(0);
  });
});
