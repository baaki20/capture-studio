import { describe, expect, it } from 'vitest';
import {
  clipFileRangeUs,
  fileToRefUs,
  mediaRefBounds,
  refToFileSeconds,
  refToFileUs,
  refToFileUsExact,
} from '../../src/shared/project/media-time';

const media = { startOffsetUs: 12_800, syncAdjustUs: 0, clockRatio: 1, durationUs: 10_000_000 };

describe('media-time', () => {
  it('implements fileUs = (refUs − startOffsetUs − syncAdjustUs) / clockRatio', () => {
    expect(refToFileUs(media, 12_800)).toBe(0);
    expect(refToFileUs(media, 1_012_800)).toBe(1_000_000);
    const drifting = { ...media, syncAdjustUs: -40_000, clockRatio: 1.0000183 };
    expect(refToFileUsExact(drifting, 600_000_000)).toBeCloseTo(
      (600_000_000 - 12_800 + 40_000) / 1.0000183,
      6,
    );
    expect(refToFileSeconds(media, 2_012_800)).toBe(2);
  });

  it('a sync nudge shifts file time without moving reference time', () => {
    const nudged = { ...media, syncAdjustUs: 50_000 };
    expect(refToFileUs(nudged, 1_062_800)).toBe(refToFileUs(media, 1_012_800));
  });

  it('round-trips between reference and file time', () => {
    const m = {
      startOffsetUs: 9_900,
      syncAdjustUs: 1_234,
      clockRatio: 0.999995,
      durationUs: 738_470_000,
    };
    for (const fileUs of [0, 1, 999_999, 123_456_789, 738_470_000]) {
      expect(Math.abs(refToFileUs(m, fileToRefUs(m, fileUs)) - fileUs)).toBeLessThanOrEqual(1);
    }
  });

  it('computes reference-time bounds, including clock ratio', () => {
    expect(mediaRefBounds(media)).toEqual({ startUs: 12_800, endUs: 10_012_800 });
    expect(mediaRefBounds({ ...media, syncAdjustUs: 100, clockRatio: 1.00002 })).toEqual({
      startUs: 12_900,
      endUs: 12_900 + 10_000_200,
    });
  });

  it('maps a clip to its file-local range', () => {
    expect(clipFileRangeUs(media, { sourceStartUs: 1_012_800, sourceEndUs: 3_012_800 })).toEqual({
      startUs: 1_000_000,
      endUs: 3_000_000,
    });
  });
});
