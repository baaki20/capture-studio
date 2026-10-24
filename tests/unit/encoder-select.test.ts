import { describe, expect, it } from 'vitest';
import {
  FrameRateMeter,
  VIDEO_CANDIDATES,
  audioEncoderConfig,
  buildVideoConfig,
  codecString,
  dropAccounting,
  fitRecordSize,
  selectVideoEncoder,
  videoBitrate,
  type EncoderProbe,
  type VideoEncoderConfigLike,
  type VideoEncoderRequest,
} from '../../src/renderer/engine/encoder-select';

const SCREEN_1080: VideoEncoderRequest = {
  role: 'screen',
  quality: 'standard',
  sourceWidth: 1920,
  sourceHeight: 1080,
  fps: 30,
};

function probe(
  supported: (c: VideoEncoderConfigLike) => boolean,
  warmUp: (c: VideoEncoderConfigLike) => boolean | Error = () => true,
): EncoderProbe & { probed: VideoEncoderConfigLike[] } {
  const probed: VideoEncoderConfigLike[] = [];
  return {
    probed,
    isConfigSupported: (config) => {
      probed.push(config);
      return Promise.resolve({ supported: supported(config) });
    },
    warmUp: (config) => {
      const r = warmUp(config);
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    },
  };
}

describe('encoder selection', () => {
  it('lands on software H.264 on the dev machine (no hardware encode, §9.4)', async () => {
    const p = probe((c) => c.hardwareAcceleration === 'prefer-software');
    const result = await selectVideoEncoder(SCREEN_1080, p);
    if (!result.ok) throw new Error('expected an encoder');
    expect(result.value.encoder).toEqual({ name: 'H.264 (software)', hardware: false });
    expect(result.value.config).toMatchObject({
      codec: 'avc1.640028',
      width: 1920,
      height: 1080,
      framerate: 30,
      hardwareAcceleration: 'prefer-software',
      avc: { format: 'avc' },
    });
    expect(result.value.attempts.map((a) => [a.candidate, a.outcome])).toEqual([
      ['H.264 (hardware)', 'unsupported'],
      ['VP9 (hardware)', 'unsupported'],
      ['AV1 (hardware)', 'unsupported'],
      ['H.264 (software)', 'selected'],
    ]);
  });

  it('tries candidates in the §4.3.4 order', async () => {
    const p = probe(() => false);
    const result = await selectVideoEncoder(SCREEN_1080, p);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('no-encoder');
    expect(
      p.probed.map((c) => [c.codec.split('.')[0], c.hardwareAcceleration, c.latencyMode]),
    ).toEqual([
      ['avc1', 'prefer-hardware', undefined],
      ['vp09', 'prefer-hardware', undefined],
      ['av01', 'prefer-hardware', undefined],
      ['avc1', 'prefer-software', undefined],
      ['vp09', 'prefer-software', 'realtime'],
      ['vp8', 'prefer-software', undefined],
    ]);
  });

  it('prefers hardware H.264 when it probes and warms up', async () => {
    const result = await selectVideoEncoder(
      SCREEN_1080,
      probe(() => true),
    );
    expect(result.ok && result.value.encoder).toEqual({ name: 'H.264 (hardware)', hardware: true });
  });

  it('moves on when the warm-up encode fails or the probe throws', async () => {
    const p: EncoderProbe = {
      isConfigSupported: (c) =>
        c.codec.startsWith('vp09') && c.hardwareAcceleration === 'prefer-hardware'
          ? Promise.reject(new TypeError('bad config'))
          : Promise.resolve({ supported: true }),
      warmUp: (c) =>
        c.codec.startsWith('avc1') && c.hardwareAcceleration === 'prefer-hardware'
          ? Promise.reject(new Error('encoder error'))
          : Promise.resolve(!c.codec.startsWith('av01')),
    };
    const result = await selectVideoEncoder(SCREEN_1080, p);
    if (!result.ok) throw new Error('expected an encoder');
    expect(result.value.encoder.name).toBe('H.264 (software)');
    expect(result.value.attempts).toEqual([
      {
        candidate: 'H.264 (hardware)',
        codec: 'avc1.640028',
        outcome: 'warm-up-failed',
        detail: 'encoder error',
      },
      {
        candidate: 'VP9 (hardware)',
        codec: 'vp09.00.40.08',
        outcome: 'probe-error',
        detail: 'bad config',
      },
      { candidate: 'AV1 (hardware)', codec: 'av01.0.08M.08', outcome: 'warm-up-failed' },
      { candidate: 'H.264 (software)', codec: 'avc1.640028', outcome: 'selected' },
    ]);
  });

  it('caps the recorded size at 1440p with the aspect preserved (§8)', () => {
    expect(fitRecordSize(3840, 2160)).toEqual({ width: 2560, height: 1440 });
    expect(fitRecordSize(2880, 1800)).toEqual({ width: 2304, height: 1440 });
    expect(fitRecordSize(1920, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(fitRecordSize(1080, 1920)).toEqual({ width: 1080, height: 1920 });
    expect(fitRecordSize(2160, 3840)).toEqual({ width: 1440, height: 2560 });
    expect(fitRecordSize(1367, 769)).toEqual({ width: 1366, height: 768 });
    const config = buildVideoConfig(VIDEO_CANDIDATES[3]!, {
      ...SCREEN_1080,
      sourceWidth: 3840,
      sourceHeight: 2160,
    });
    expect(config).toMatchObject({ width: 2560, height: 1440, codec: 'avc1.640032' });
  });

  it('computes the §4.3.4 bitrate', () => {
    expect(videoBitrate('screen', 'standard', 1920, 1080, 30)).toBe(4_354_560);
    expect(videoBitrate('screen', 'high', 1920, 1080, 30)).toBe(6_967_296);
    expect(videoBitrate('screen', 'standard', 2560, 1440, 30)).toBe(7_741_440);
    expect(videoBitrate('screen', 'standard', 1280, 720, 30)).toBe(4_000_000);
    expect(videoBitrate('screen', 'standard', 7680, 4320, 60)).toBe(40_000_000);
    expect(videoBitrate('screen', 'high', 7680, 4320, 60)).toBe(64_000_000);
    expect(videoBitrate('camera', 'standard', 1280, 720, 30)).toBe(4_000_000);
    expect(videoBitrate('camera', 'high', 1280, 720, 30)).toBe(6_000_000);
  });

  it('builds codec strings with a level that fits size and rate', () => {
    expect(codecString('h264', 1280, 720, 30)).toBe('avc1.64001F');
    expect(codecString('h264', 1920, 1080, 30)).toBe('avc1.640028');
    expect(codecString('h264', 1920, 1080, 60)).toBe('avc1.64002A');
    expect(codecString('h264', 2560, 1440, 30)).toBe('avc1.640032');
    expect(codecString('vp9', 1920, 1080, 30)).toBe('vp09.00.40.08');
    expect(codecString('vp9', 2560, 1440, 30)).toBe('vp09.00.50.08');
    expect(codecString('av1', 1920, 1080, 60)).toBe('av01.0.09M.08');
    expect(codecString('vp8', 1920, 1080, 30)).toBe('vp8');
  });

  it('configures Opus per §4.3.4', () => {
    expect(audioEncoderConfig('microphone', 1)).toEqual({
      codec: 'opus',
      sampleRate: 48_000,
      numberOfChannels: 1,
      bitrate: 128_000,
    });
    expect(audioEncoderConfig('microphone', 2).numberOfChannels).toBe(2);
    expect(audioEncoderConfig('system-audio')).toEqual({
      codec: 'opus',
      sampleRate: 48_000,
      numberOfChannels: 2,
      bitrate: 192_000,
    });
  });
});

describe('camera frame-rate accounting (§9.3)', () => {
  it('measures the delivered rate from frame timestamps, ignoring a stall', () => {
    const meter = new FrameRateMeter();
    expect(meter.fps).toBeNull();
    let t = 0;
    for (let i = 0; i < 100; i++) {
      t += i === 50 ? 500_000 : 59_880 + ((i * 7919) % 2_000) - 1_000; // ≈16.7 fps with jitter
      meter.onFrame(t);
    }
    expect(meter.fps).toBeGreaterThan(16.4);
    expect(meter.fps).toBeLessThan(17.0);
  });

  it('counts drops against the delivered rate, not the requested one', () => {
    // 10 s of a camera that delivers 16.7 fps although 30 was requested.
    const base = { activeUs: 10_000_000, requestedFps: 30, deliveredFps: 16.7 };
    const clean = dropAccounting({ ...base, framesIn: 167, framesDropped: 0 });
    expect(clean).toMatchObject({
      expectedFrames: 167,
      droppedRatio: 0,
      level: 'ok',
      belowRequested: true,
    });
    expect(dropAccounting({ ...base, framesIn: 167, framesDropped: 2 }).level).toBe('amber');
    expect(dropAccounting({ ...base, framesIn: 167, framesDropped: 10 }).level).toBe('red');
    // The same counts against the requested 30 fps would be wrong; with no measurement the
    // requested rate is the fallback.
    const fallback = dropAccounting({
      ...base,
      deliveredFps: null,
      framesIn: 167,
      framesDropped: 0,
    });
    expect(fallback.expectedFrames).toBe(300);
    expect(fallback.belowRequested).toBe(false);
    expect(
      dropAccounting({ ...base, framesIn: 0, framesDropped: 0, activeUs: 0 }).droppedRatio,
    ).toBe(0);
  });
});
