import { describe, expect, it } from 'vitest';
import { ENGINE_COMMANDS, ENGINE_EVENTS } from '../../src/shared/ipc/contract';
import { RecordedStreamSchema } from '../../src/shared/project/from-recording';
import { resolveCalibration } from '../../src/renderer/engine/pipeline/calibration';
import {
  missingResult,
  streamResult,
  type WorkerResult,
} from '../../src/renderer/engine/pipeline/results';
import { StatsAggregator, StreamCounters } from '../../src/renderer/engine/pipeline/stats';

describe('StreamCounters', () => {
  it('reports video drops against the delivered rate (§9.3)', () => {
    const c = new StreamCounters({ kind: 'camera', streamId: 'str_cam', requestedFps: 30 });
    c.framesIn = 110;
    c.framesPaused = 10;
    c.framesEncoded = 98;
    c.framesDropped = 2;
    c.bytes = 1234;
    const s = c.snapshot({
      state: 'recording',
      queueDepth: 3.4,
      deliveredFps: 16.7,
      activeUs: 6_000_000,
    });
    expect(s).toMatchObject({
      kind: 'camera',
      streamId: 'str_cam',
      framesIn: 110,
      framesEncoded: 98,
      framesDropped: 2,
      framesPaused: 10,
      bytes: 1234,
      queueDepth: 3,
      deliveredFps: 16.7,
      dropLevel: 'amber', // 2 of ~100 expected at 16.7 fps
      state: 'recording',
    });
    expect(s.droppedRatio).toBeCloseTo(0.02, 2);
    expect(s.checkpoints).toBeUndefined();
    expect(ENGINE_EVENTS['engine.stats'].safeParse({ atUs: 1, streams: [s] }).success).toBe(true);
  });

  it('hands out audio peaks and new checkpoints once per report', () => {
    const c = new StreamCounters({ kind: 'mic', streamId: 'str_mic' });
    c.notePeak(0.2);
    c.notePeak(0.6);
    c.notePeak(0.1);
    c.addCheckpoint([1_000, 48_000]);
    c.samplesWritten = 48_000;
    const first = c.snapshot({ state: 'recording', queueDepth: 0 });
    expect(first).toMatchObject({
      level: 0.6,
      checkpoints: [[1_000, 48_000]],
      samplesWritten: 48_000,
    });
    expect(first.dropLevel).toBeUndefined();
    c.addCheckpoint([2_000, 96_000]);
    const second = c.snapshot({ state: 'recording', queueDepth: 0 });
    expect(second).toMatchObject({ level: 0, checkpoints: [[2_000, 96_000]] });
    expect(c.checkpoints).toEqual([
      [1_000, 48_000],
      [2_000, 96_000],
    ]);
  });
});

describe('StatsAggregator', () => {
  const base = {
    framesIn: 1,
    framesEncoded: 1,
    framesDropped: 0,
    bytes: 0,
    discontinuities: 0,
    queueDepth: 0,
  };

  it('keeps the latest report per stream and merges audio peaks and checkpoints', () => {
    const a = new StatsAggregator();
    a.update({ ...base, kind: 'screen', streamId: 's', framesIn: 10 });
    a.update({ ...base, kind: 'screen', streamId: 's', framesIn: 20 });
    a.update({ ...base, kind: 'mic', streamId: 'm', level: 0.5, checkpoints: [[1, 10]] });
    a.update({ ...base, kind: 'mic', streamId: 'm', level: 0.2, checkpoints: [[2, 20]] });
    const sent = a.drain(99);
    expect(sent.atUs).toBe(99);
    expect(sent.streams).toHaveLength(2);
    expect(sent.streams[0]).toMatchObject({ kind: 'screen', framesIn: 20 });
    expect(sent.streams[1]).toMatchObject({
      level: 0.5,
      checkpoints: [
        [1, 10],
        [2, 20],
      ],
    });
    // Drained: peaks and checkpoints are not sent twice.
    expect(a.drain(100).streams[1]).toMatchObject({ level: 0, checkpoints: [] });
    a.remove('s');
    expect(a.size).toBe(1);
  });
});

/** Warm-up samples: arrival = timestamp + offset + latency jitter. */
function samples(offsetUs: number, count: number, stepUs: number, jitterUs = 2_000) {
  return Array.from({ length: count }, (_, i) => ({
    arrivalUs: i * stepUs + offsetUs + (i % 3) * (jitterUs / 2),
    timestampUs: i * stepUs,
  }));
}

describe('resolveCalibration (hybrid, §9.2)', () => {
  it('shares the screen domain with the camera and arrival-calibrates the mic', () => {
    const resolved = resolveCalibration([
      { streamId: 'str_s', kind: 'screen', samples: samples(5_000_000, 60, 33_333) },
      { streamId: 'str_c', kind: 'camera', samples: samples(5_001_000, 40, 50_000) },
      { streamId: 'str_m', kind: 'mic', samples: samples(25_000_000, 100, 20_000) },
      { streamId: 'str_x', kind: 'camera', samples: [] },
    ]);
    expect(resolved.error).toBeNull();
    expect(resolved.result?.clockMode).toBe('arrival-calibrated');
    expect(resolved.byStream.get('str_s')?.mode).toBe('shared');
    expect(resolved.byStream.get('str_c')?.mode).toBe('shared');
    expect(resolved.byStream.get('str_c')?.offsetUs).toBe(resolved.byStream.get('str_s')?.offsetUs);
    expect(resolved.byStream.get('str_m')).toMatchObject({
      mode: 'arrival-calibrated',
      clockHandshakeUs: null,
    });
    expect(resolved.byStream.get('str_m')?.offsetUs).toBeCloseTo(25_000_000, -4);
    expect(resolved.byStream.has('str_x')).toBe(false);
  });

  it('returns nothing when no track has samples', () => {
    expect(resolveCalibration([{ streamId: 'a', kind: 'screen', samples: [] }])).toEqual({
      result: null,
      byStream: new Map(),
      error: null,
    });
  });
});

describe('stream results', () => {
  const worker: WorkerResult = {
    streamId: 'str_mic',
    kind: 'mic',
    status: 'ok',
    endedEarly: false,
    endedAtUs: 9_000_000,
    error: null,
    encoder: { name: 'Opus (WebCodecs)', hardware: false },
    codec: 'opus',
    firstTimestampUs: 1_000_000,
    video: null,
    audio: { sampleRate: 48_000, channels: 1, samplesWritten: 96_000, silenceSamples: 4_800 },
    checkpoints: [[8_000_000, 48_000]],
    writer: {
      bytesWritten: 10,
      writes: 2,
      outOfOrder: 0,
      size: 10,
      fsyncs: 1,
      lastFsyncAt: null,
    },
    stats: {
      kind: 'mic',
      streamId: 'str_mic',
      framesIn: 100,
      framesEncoded: 100,
      framesDropped: 0,
      bytes: 10,
      discontinuities: 1,
      queueDepth: 0,
      checkpoints: [],
    },
    samples: [],
  };
  const sync = {
    mode: 'arrival-calibrated' as const,
    offsetUs: 7_000_000,
    clockHandshakeUs: null,
    reason: 'policy hybrid',
    stats: {
      samples: 100,
      medianUs: 7_000_100,
      lowUs: 7_000_000,
      spreadUs: 400,
      minUs: 6_999_900,
      maxUs: 7_001_000,
      stable: true,
    },
  };

  it('maps the first sample to the reference clock and fits the stop contract', () => {
    const entry = streamResult(worker, sync, 7_500_000);
    expect(entry).toMatchObject({
      streamId: 'str_mic',
      status: 'ok',
      startOffsetUs: 500_000, // 1 s + 7 s − 7.5 s
      calibration: { mode: 'arrival-calibrated', offsetUs: 7_000_000, clockHandshakeUs: null },
      nominalRate: 48_000,
      checkpoints: [[8_000_000, 48_000]],
      discontinuities: 1,
    });
    expect(entry.video).toBeUndefined();
    const reply = ENGINE_COMMANDS['engine.stop'].response.safeParse({
      streams: [entry],
      t0Us: 7_500_000,
      pauses: [],
    });
    expect(reply.success).toBe(true);
    // The manifest's per-stream sync block accepts it as is.
    expect(RecordedStreamSchema.shape.sync.safeParse(entry.calibration).success).toBe(true);
  });

  it('omits what is unknown instead of sending nulls', () => {
    const entry = streamResult(missingResult('str_s', 'screen', null, 5), null, 0);
    expect(entry).toMatchObject({ status: 'failed', endedAtUs: 5, endedEarly: false });
    for (const key of ['startOffsetUs', 'sync', 'calibration', 'encoder', 'video', 'writer']) {
      expect(entry).not.toHaveProperty(key);
    }
    expect(ENGINE_COMMANDS['engine.stop'].response.safeParse({ streams: [entry] }).success).toBe(
      true,
    );
  });
});

describe('engine contract additions', () => {
  it('accepts the start reply with the clock handshake and per-stream details', () => {
    const parsed = ENGINE_COMMANDS['engine.start'].response.parse({
      t0Us: 1,
      streams: [
        {
          kind: 'screen',
          streamId: 'str_s',
          encoder: { name: 'H.264 (software)', hardware: false },
          codec: 'avc1.640028',
          width: 1920,
          height: 1080,
          sourceWidth: 1920,
          sourceHeight: 1080,
        },
      ],
      clock: { offsetUs: -114, externalClockOffsetUs: 114, rttUs: 100, samples: 8 },
      utilityClockOffsetUs: -114,
    });
    expect(parsed.utilityClockOffsetUs).toBe(-114);
    expect(parsed.clock?.externalClockOffsetUs).toBe(114);
  });

  it('keeps older acquire replies valid (warnings are optional)', () => {
    const reply = { status: 'cancelled', screen: null, camera: null, mic: null };
    expect(ENGINE_COMMANDS['engine.acquire'].response.safeParse(reply).success).toBe(true);
    expect(
      ENGINE_COMMANDS['engine.acquire'].response.safeParse({
        ...reply,
        warnings: [{ kind: 'camera', message: 'camera unavailable' }],
      }).success,
    ).toBe(true);
  });
});
