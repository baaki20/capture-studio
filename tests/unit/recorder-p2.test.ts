/**
 * Recorder additions (P2, R2.29–R2.33): letterboxing a resized window, crop clamping, the
 * fixed-duration timer text, window sources, hardware-only encoder selection, and the quick-GIF
 * workflow.
 */
import { describe, expect, it, vi } from 'vitest';
import { pickScreenSource, type GetSources } from '../../src/main/display-media';
import type { ExportJobEvent } from '../../src/main/ipc/export-handlers';
import { exportQuickGif, quickGifOptions } from '../../src/main/recording/quick-gif';
import { formatLimit } from '../../src/main/recording/session-manager';
import { formatTimer } from '../../src/renderer/common/recorder-format';
import {
  HARDWARE_CANDIDATES,
  selectVideoEncoder,
  type VideoEncoderConfigLike,
} from '../../src/renderer/engine/encoder-select';
import { clampCrop, letterboxRect } from '../../src/shared/recording/region';

const S = 1_000_000;

describe('letterbox (acceptance f)', () => {
  it('fits a resized window inside the recording size, centred', () => {
    // Recorded at 1280×720; the window becomes 1000×800 (pillarbox) or 1600×400 (letterbox).
    expect(letterboxRect({ width: 1000, height: 800 }, { width: 1280, height: 720 })).toEqual({
      x: 190,
      y: 0,
      width: 900,
      height: 720,
    });
    expect(letterboxRect({ width: 1600, height: 400 }, { width: 1280, height: 720 })).toEqual({
      x: 0,
      y: 200,
      width: 1280,
      height: 320,
    });
  });

  it('fills the frame when the aspect matches within a pixel (a scaled monitor)', () => {
    expect(letterboxRect({ width: 3840, height: 2160 }, { width: 2560, height: 1440 })).toEqual({
      x: 0,
      y: 0,
      width: 2560,
      height: 1440,
    });
    expect(letterboxRect({ width: 1366, height: 768 }, { width: 1366, height: 768 })).toMatchObject(
      {
        x: 0,
        width: 1366,
      },
    );
  });

  it('clamps a crop to a smaller frame', () => {
    const crop = { x: 100, y: 100, width: 800, height: 600 };
    expect(clampCrop(crop, { width: 1920, height: 1080 })).toEqual(crop);
    expect(clampCrop(crop, { width: 500, height: 400 })).toEqual({
      x: 100,
      y: 100,
      width: 400,
      height: 300,
    });
    expect(clampCrop(crop, { width: 101, height: 101 })).toBeNull();
  });
});

describe('fixed duration', () => {
  it('counts down in the controls and names the limit', () => {
    expect(formatTimer(65 * S, null)).toBe('01:05');
    expect(formatTimer(0, 300 * S)).toBe('−05:00');
    expect(formatTimer(0.4 * S, 300 * S)).toBe('−05:00');
    expect(formatTimer(299.5 * S, 300 * S)).toBe('−00:01');
    expect(formatTimer(301 * S, 300 * S)).toBe('−00:00');
    expect(formatLimit(30)).toBe('30 s');
    expect(formatLimit(300)).toBe('5 min');
    expect(formatLimit(5400)).toBe('1 h 30 min');
    expect(formatLimit(90)).toBe('90 s');
  });
});

describe('window sources', () => {
  it('asks for windows in window mode', async () => {
    const getSources = vi.fn<GetSources>(() =>
      Promise.resolve([{ id: 'window:3', name: 'Editor' }]),
    );
    const picked = await pickScreenSource(getSources, { fps: 30, sourceType: 'window' });
    expect(getSources.mock.calls[0]?.[0].types).toEqual(['window']);
    expect(picked).toMatchObject({ status: 'selected', screen: { sourceId: 'window:3' } });
    await pickScreenSource(getSources, { fps: 30 });
    expect(getSources.mock.calls[1]?.[0].types).toEqual(['screen']);
  });
});

describe('hardware encoder requirement', () => {
  it('tries only hardware candidates and fails without one', async () => {
    const tried: VideoEncoderConfigLike[] = [];
    const probe = {
      isConfigSupported: (c: VideoEncoderConfigLike) => {
        tried.push(c);
        return Promise.resolve({ supported: c.hardwareAcceleration === 'prefer-software' });
      },
      warmUp: () => Promise.resolve(true),
    };
    const request = {
      role: 'screen' as const,
      quality: 'standard' as const,
      sourceWidth: 1920,
      sourceHeight: 1080,
      fps: 30,
    };
    const result = await selectVideoEncoder(request, probe, HARDWARE_CANDIDATES);
    expect(result.ok).toBe(false);
    expect(tried.every((c) => c.hardwareAcceleration === 'prefer-hardware')).toBe(true);
    expect(tried.length).toBe(HARDWARE_CANDIDATES.length);
  });
});

describe('quick GIF', () => {
  function service(result: { status: 'started' | 'exists' | 'blocked'; message?: string }) {
    const listeners = new Set<(e: ExportJobEvent) => void>();
    return {
      started: [] as unknown[],
      emit: (e: ExportJobEvent) => {
        for (const l of listeners) l(e);
      },
      start(request: unknown) {
        this.started.push(request);
        return Promise.resolve({
          jobId: result.status === 'started' ? 'job_1' : null,
          status: result.status,
          path: '/exports/Lesson.gif',
          message: result.message ?? null,
        });
      },
      onJobEvent(listener: (e: ExportJobEvent) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  }

  it('exports the Small GIF and reveals it', async () => {
    const exports = service({ status: 'started' });
    const shown: string[] = [];
    const done = exportQuickGif({ exports, showItemInFolder: (p) => shown.push(p) }, 'prj_1');
    await new Promise((r) => setTimeout(r, 0));
    exports.emit({ type: 'progress', jobId: 'job_1', fraction: 0.5, etaSec: 1 });
    exports.emit({
      type: 'done',
      jobId: 'job_2',
      outputPath: '/other.gif',
      encoder: 'gif',
      notice: null,
    });
    exports.emit({
      type: 'done',
      jobId: 'job_1',
      outputPath: '/exports/Lesson.gif',
      encoder: 'gif',
      notice: null,
    });
    await expect(done).resolves.toBe('/exports/Lesson.gif');
    expect(shown).toEqual(['/exports/Lesson.gif']);
    expect(exports.started[0]).toMatchObject({ projectId: 'prj_1', options: quickGifOptions() });
    expect(quickGifOptions()).toMatchObject({ format: 'gif', gif: { maxWidth: 480 } });
  });

  it('fails without replacing an existing file, and reports export errors', async () => {
    const show = vi.fn();
    await expect(
      exportQuickGif({ exports: service({ status: 'exists' }), showItemInFolder: show }, 'p'),
    ).rejects.toThrow(/already exists/);
    const failing = service({ status: 'started' });
    const run = exportQuickGif({ exports: failing, showItemInFolder: show }, 'p');
    await new Promise((r) => setTimeout(r, 0));
    failing.emit({ type: 'error', jobId: 'job_1', message: 'encoder broke', cancelled: false });
    await expect(run).rejects.toThrow('encoder broke');
    expect(show).not.toHaveBeenCalled();
  });
});
