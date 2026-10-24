import { describe, expect, it } from 'vitest';
import {
  assertUs,
  formatTimecode,
  frameDurationUs,
  frameToUs,
  isUs,
  msToUs,
  parseTimecode,
  secondsToUs,
  snapToFrame,
  usToFrame,
  usToSeconds,
} from '../../src/shared/time';

describe('time', () => {
  it('recognises integer microseconds', () => {
    expect(isUs(0)).toBe(true);
    expect(isUs(-5)).toBe(true);
    expect(isUs(1.5)).toBe(false);
    expect(isUs(Number.NaN)).toBe(false);
    expect(isUs('1')).toBe(false);
    expect(() => assertUs(0.5, 'start')).toThrow(/start/);
  });

  it('converts units with rounding to whole µs', () => {
    expect(msToUs(1.2345)).toBe(1235);
    expect(secondsToUs(1.5)).toBe(1_500_000);
    expect(usToSeconds(2_500_000)).toBe(2.5);
  });

  it('places frame boundaries without accumulating error', () => {
    expect(frameToUs(30, 30)).toBe(1_000_000);
    expect(frameToUs(1, 30)).toBe(33_333);
    expect(frameToUs(2, 30)).toBe(66_667);
    expect(frameDurationUs(30)).toBe(33_333);
    expect(frameDurationUs(25)).toBe(40_000);
  });

  it('maps times to frames and back for every Phase 1 rate', () => {
    for (const fps of [24, 25, 30, 50, 60]) {
      for (let i = 0; i < 500; i++) {
        const start = frameToUs(i, fps);
        expect(usToFrame(start, fps)).toBe(i);
        expect(usToFrame(frameToUs(i + 1, fps) - 1, fps)).toBe(i);
      }
    }
  });

  it('snaps to frame boundaries', () => {
    expect(snapToFrame(40_000, 30, 'floor')).toBe(33_333);
    expect(snapToFrame(40_000, 30, 'ceil')).toBe(66_667);
    expect(snapToFrame(40_000, 30, 'nearest')).toBe(33_333);
    expect(snapToFrame(60_000, 30)).toBe(66_667);
    expect(snapToFrame(66_667, 30, 'ceil')).toBe(66_667);
  });

  it('formats and parses hh:mm:ss:ff timecode', () => {
    expect(formatTimecode(0, 30)).toBe('00:00:00:00');
    expect(formatTimecode(3_723_500_000, 30)).toBe('01:02:03:15');
    expect(formatTimecode(-1_000_000, 25)).toBe('-00:00:01:00');
    expect(formatTimecode(360_000_000_000, 30)).toBe('100:00:00:00');
    expect(parseTimecode('01:02:03:15', 30)).toBe(3_723_500_000);
    expect(parseTimecode('00:00:00:30', 30)).toBeNull();
    expect(parseTimecode('nonsense', 30)).toBeNull();
    for (const us of [0, 33_333, 1_234_567_890]) {
      const tc = formatTimecode(us, 30);
      expect(parseTimecode(tc, 30)).toBe(snapToFrame(us, 30, 'floor'));
    }
  });

  it('rejects non-integer frame rates', () => {
    expect(() => frameToUs(1, 29.97)).toThrow(RangeError);
  });
});
