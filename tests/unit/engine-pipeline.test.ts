import { describe, expect, it, vi } from 'vitest';
import { AudioContinuity } from '../../src/shared/recording/audio-continuity';
import {
  layoutAudioOps,
  peakOf,
  sourceChannel,
} from '../../src/renderer/engine/pipeline/audio-render';
import {
  cameraConstraints,
  isCancelError,
  micConstraints,
  screenConstraints,
} from '../../src/renderer/engine/pipeline/constraints';
import { PauseSchedule } from '../../src/renderer/engine/pipeline/pause-gate';
import { CachedEncoderProbe } from '../../src/renderer/engine/pipeline/probe-cache';
import { SessionStamper, startOffsetUs } from '../../src/renderer/engine/pipeline/stamp';
import { TimestampRebaser } from '../../src/renderer/engine/pipeline/timestamp-rebase';
import {
  KEYFRAME_INTERVAL_US,
  KeyframeCadence,
  shouldDropForBackpressure,
} from '../../src/renderer/engine/pipeline/video-policy';
import {
  buildVideoConfig,
  selectVideoEncoder,
  VIDEO_CANDIDATES,
  type EncoderProbe,
} from '../../src/renderer/engine/encoder-select';

describe('SessionStamper', () => {
  it('uses the least-delayed arrival as the provisional offset', () => {
    const s = new SessionStamper();
    expect(s.offsetUs).toBeNull();
    expect(s.toSession(100, 5_000)).toBe(5_000); // fallback before any observation
    s.observe(10_050, 50); // latency 10 000
    s.observe(10_120, 100); // 10 020
    s.observe(10_130, 140); // 9 990 (least delayed)
    expect(s.offsetUs).toBe(9_990);
    expect(s.toSession(1_000, 0)).toBe(10_990);
  });

  it('switches to the calibrated offset for good', () => {
    const s = new SessionStamper();
    s.observe(1_000, 0);
    s.calibrate(700);
    s.observe(100, 0); // a smaller provisional offset no longer matters
    expect(s.isCalibrated).toBe(true);
    expect(s.offsetUs).toBe(700);
  });

  it('computes RecordedStream.startOffsetUs relative to t0', () => {
    expect(startOffsetUs(5_000_000, 1_000_000, 5_900_000)).toBe(100_000);
    expect(startOffsetUs(10.4, 0.4, 0)).toBe(11);
  });
});

describe('PauseSchedule (video pause gate)', () => {
  it('drops frames inside [start, end) and ignores repeated presses', () => {
    const p = new PauseSchedule();
    expect(p.pause(1_000)).toBe(true);
    expect(p.pause(1_500)).toBe(false);
    expect(p.paused).toBe(true);
    expect(p.isPaused(999)).toBe(false);
    expect(p.isPaused(1_000)).toBe(true);
    expect(p.isPaused(1e12)).toBe(true); // open pause
    expect(p.resume(2_000)).toBe(true);
    expect(p.resume(2_500)).toBe(false);
    expect(p.isPaused(1_999)).toBe(true);
    expect(p.isPaused(2_000)).toBe(false);
  });

  it('measures active time without pauses and closes the open one at now', () => {
    const p = new PauseSchedule();
    p.pause(1_000);
    p.resume(3_000);
    p.pause(5_000);
    expect(p.activeUs(0, 6_000)).toBe(3_000);
    expect(p.activeUs(2_000, 4_000)).toBe(1_000);
    expect(p.activeUs(5, 5)).toBe(0);
    expect(p.spansUntil(7_000)).toEqual([
      { startUs: 1_000, endUs: 3_000 },
      { startUs: 5_000, endUs: 7_000 },
    ]);
  });

  it('clamps a resume before the pause start', () => {
    const p = new PauseSchedule();
    p.pause(1_000);
    p.resume(500);
    expect(p.spansUntil(9_000)).toEqual([{ startUs: 1_000, endUs: 1_000 }]);
  });
});

describe('video policies', () => {
  it('drops a frame only when the encode queue exceeds 2 × fps', () => {
    expect(shouldDropForBackpressure(60, 30)).toBe(false);
    expect(shouldDropForBackpressure(61, 30)).toBe(true);
    expect(shouldDropForBackpressure(120, 60)).toBe(false);
    expect(shouldDropForBackpressure(121, 60)).toBe(true);
  });

  /** File times of forced keyframes for a frame sequence. */
  function keyGaps(fps: number, frameTimes: number[]): number[] {
    const cadence = new KeyframeCadence(1_000_000 / fps);
    const keys = frameTimes.filter((t) => cadence.next(t));
    return keys.slice(1).map((k, i) => k - (keys[i] ?? 0));
  }

  it.each([30, 60])('keeps keyframes within 1 s when frames arrive on time (%i fps)', (fps) => {
    const frames = Array.from({ length: fps * 10 }, (_, i) => Math.round((i * 1_000_000) / fps));
    const gaps = keyGaps(fps, frames);
    expect(gaps.length).toBeGreaterThanOrEqual(9);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(KEYFRAME_INTERVAL_US);
    expect(Math.min(...gaps)).toBeGreaterThan(KEYFRAME_INTERVAL_US - 2_000_000 / fps);
  });

  it('exceeds 1 s only by the lateness of the stream itself (VFR gaps, jitter)', () => {
    const fps = 30;
    const frameUs = 1_000_000 / fps;
    let t = 0;
    const frames: number[] = [];
    for (let i = 0; i < fps * 10; i += 1) {
      // ±3 ms jitter and a missing frame now and then.
      t +=
        frameUs + (i % 7 === 3 ? 3_000 : i % 7 === 5 ? -3_000 : 0) + (i % 50 === 49 ? frameUs : 0);
      frames.push(Math.round(t));
    }
    expect(Math.max(...keyGaps(fps, frames))).toBeLessThanOrEqual(
      KEYFRAME_INTERVAL_US + frameUs + 3_000,
    );
  });

  it('starts with a keyframe and restarts the interval on an encoder keyframe', () => {
    const cadence = new KeyframeCadence(33_333);
    expect(cadence.next(0)).toBe(true);
    expect(cadence.next(500_000)).toBe(false);
    cadence.observedKey(600_000);
    cadence.observedKey(100_000); // older: ignored
    expect(cadence.next(1_000_000)).toBe(false);
    expect(cadence.next(1_600_000)).toBe(true);
  });
});

describe('audio rendering of continuity plans', () => {
  it('lays segments out after the frames already written, with file timestamps', () => {
    const c = new AudioContinuity({ sampleRate: 48_000 });
    expect(layoutAudioOps(c.plan({ timeUs: 0, frames: 480 }).ops, 0, 48_000)).toEqual([
      { type: 'copy', fromFrame: 0, frames: 480, fileFrame: 0, timestampUs: 0 },
    ]);
    // A 100 ms gap is filled with silence before the chunk.
    const gap = c.plan({ timeUs: 110_000, frames: 480 });
    expect(layoutAudioOps(gap.ops, 480, 48_000)).toEqual([
      { type: 'silence', frames: 4_800, fileFrame: 480, timestampUs: 10_000, cause: 'gap' },
      { type: 'copy', fromFrame: 0, frames: 480, fileFrame: 5_280, timestampUs: 110_000 },
    ]);
  });

  it('replaces paused frames with silence of the same length', () => {
    const c = new AudioContinuity({ sampleRate: 48_000 });
    c.pause(5_000);
    c.resume(7_500);
    const plan = c.plan({ timeUs: 0, frames: 480, sessionUs: 0 }); // 0–10 ms
    const segments = layoutAudioOps(plan.ops, 0, 48_000);
    expect(segments.map((s) => [s.type, s.frames])).toEqual([
      ['copy', 240],
      ['silence', 120],
      ['copy', 120],
    ]);
    expect(segments.reduce((n, s) => n + s.frames, 0)).toBe(480);
    expect(segments[2]).toMatchObject({ fromFrame: 360, fileFrame: 360, timestampUs: 7_500 });
  });

  it('maps channels and measures peaks', () => {
    expect([0, 1].map((c) => sourceChannel(c, 1))).toEqual([0, 0]); // mono → stereo
    expect([0, 1].map((c) => sourceChannel(c, 4))).toEqual([0, 1]);
    expect(peakOf([new Float32Array([0.1, -0.7]), [0.3]])).toBeCloseTo(0.7);
    expect(peakOf([])).toBe(0);
  });
});

describe('TimestampRebaser', () => {
  it('passes ordinary jitter through untouched', () => {
    const r = new TimestampRebaser();
    for (let i = 0; i < 100; i += 1) {
      const ts = i * 10_000;
      const jitter = (i % 5) * 4_000;
      expect(r.map(1_000_000 + ts + 10_000 + jitter, ts, 10_000)).toEqual({
        timestampUs: ts,
        jumped: false,
      });
    }
    expect(r.jumps).toBe(0);
  });

  it('re-anchors timestamps that restart in another domain', () => {
    const r = new TimestampRebaser();
    // The first chunk carries a timestamp 22 s ahead of the following ones (seen in practice).
    expect(r.map(5_000_000, 22_000_000, 10_000).jumped).toBe(false);
    const second = r.map(5_010_000, 0, 10_000);
    expect(second.jumped).toBe(true);
    expect(second.timestampUs).toBe(22_010_000);
    const third = r.map(5_020_500, 10_000, 10_000);
    expect(third).toEqual({ timestampUs: 22_020_000, jumped: false });
    expect(r.jumps).toBe(1);
  });
});

describe('acquisition constraints (§4.3.2, §9.1)', () => {
  it('always passes the max size and rate for the desktop source', () => {
    expect(
      screenConstraints({ sourceId: 'screen:1:0', maxWidth: 3840, maxHeight: 2160, fps: 60 }),
    ).toEqual({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: 'screen:1:0',
          maxWidth: 3840,
          maxHeight: 2160,
          maxFrameRate: 60,
        },
      },
    });
  });

  it('opens camera and mic by exact device id with the setup choices', () => {
    expect(cameraConstraints({ deviceId: 'cam' }).video).toMatchObject({
      deviceId: { exact: 'cam' },
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    });
    expect(
      micConstraints({
        deviceId: 'mic',
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: false,
      }).audio,
    ).toEqual({
      deviceId: { exact: 'mic' },
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: { ideal: 1 },
    });
  });

  it('treats NotAllowedError and AbortError as a cancel', () => {
    expect(isCancelError({ name: 'NotAllowedError', message: 'Permission denied' })).toBe(true);
    expect(isCancelError({ name: 'AbortError', message: '' })).toBe(true);
    expect(isCancelError({ name: 'NotReadableError', message: '' })).toBe(false);
    expect(isCancelError('nope')).toBe(false);
  });
});

describe('CachedEncoderProbe', () => {
  it('warms each codec/size up once across quality changes', async () => {
    const warmUp = vi.fn(() => Promise.resolve(true));
    const inner: EncoderProbe = {
      isConfigSupported: (c) =>
        Promise.resolve({ supported: c.hardwareAcceleration === 'prefer-software' }),
      warmUp,
    };
    const probe = new CachedEncoderProbe(inner);
    const request = { role: 'screen' as const, sourceWidth: 1920, sourceHeight: 1080, fps: 30 };
    const standard = await selectVideoEncoder({ ...request, quality: 'standard' }, probe);
    const high = await selectVideoEncoder({ ...request, quality: 'high' }, probe);
    expect(standard.ok && high.ok).toBe(true);
    if (standard.ok && high.ok) {
      expect(standard.value.encoder.name).toBe('H.264 (software)');
      expect(high.value.config.bitrate).toBeGreaterThan(standard.value.config.bitrate);
    }
    expect(warmUp).toHaveBeenCalledTimes(1);
  });

  it('does not cache a thrown warm-up', async () => {
    const warmUp = vi
      .fn<EncoderProbe['warmUp']>()
      .mockRejectedValueOnce(new Error('busy'))
      .mockResolvedValue(true);
    const probe = new CachedEncoderProbe({
      isConfigSupported: () => Promise.resolve({ supported: true }),
      warmUp,
    });
    const config = buildVideoConfig(VIDEO_CANDIDATES[3]!, {
      role: 'camera',
      quality: 'standard',
      sourceWidth: 1280,
      sourceHeight: 720,
      fps: 30,
    });
    await expect(probe.warmUp(config)).rejects.toThrow('busy');
    await expect(probe.warmUp(config)).resolves.toBe(true);
    await expect(probe.warmUp(config)).resolves.toBe(true);
    expect(warmUp).toHaveBeenCalledTimes(2);
  });
});
