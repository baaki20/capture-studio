import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PendingLoads } from '../../src/renderer/editor/Timeline/pending-loads';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PendingLoads (R1.44: waveforms and thumbnails wait for main)', () => {
  it('retries after the delay', () => {
    const loads = new PendingLoads(10_000);
    const fn = vi.fn();
    loads.retry('peaks:med_mic', fn);
    vi.advanceTimersByTime(9_999);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(loads.size).toBe(0);
  });

  it('runs every waiting load at once on media.cachesReady, and no timer fires later', () => {
    const loads = new PendingLoads(10_000);
    const peaks = vi.fn();
    const thumbs = vi.fn();
    loads.retry('peaks:med_mic', peaks);
    loads.retry('thumbs:med_screen', thumbs);
    loads.retryNow();
    expect(peaks).toHaveBeenCalledTimes(1);
    expect(thumbs).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);
    expect(peaks).toHaveBeenCalledTimes(1);
    expect(thumbs).toHaveBeenCalledTimes(1);
  });

  it('keeps only the latest retry per key', () => {
    const loads = new PendingLoads(1_000);
    const first = vi.fn();
    const second = vi.fn();
    loads.retry('peaks:med_mic', first);
    vi.advanceTimersByTime(500);
    loads.retry('peaks:med_mic', second);
    vi.advanceTimersByTime(2_000);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('runs nothing after dispose', () => {
    const loads = new PendingLoads(1_000);
    const fn = vi.fn();
    loads.retry('peaks:med_mic', fn);
    loads.dispose();
    loads.retryNow();
    vi.advanceTimersByTime(5_000);
    loads.retry('peaks:med_mic', fn);
    vi.advanceTimersByTime(5_000);
    expect(fn).not.toHaveBeenCalled();
  });
});
