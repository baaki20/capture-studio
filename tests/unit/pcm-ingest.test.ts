import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LevelTracker,
  opusEncoderArgs,
  PcmIngest,
  peakOfS16,
  pwRecordCommand,
  SystemAudioMonitor,
} from '../../src/utility/media/pcm-ingest';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-pcm-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** Fake child processes: the capture's stdout is fed by the test, the encoder's stdin is captured. */
function fakeSpawn() {
  const spawned: { file: string; args: readonly string[]; child: ChildProcess }[] = [];
  const encoderInput: Buffer[] = [];
  const spawnImpl = (file: string, args: readonly string[]): ChildProcess => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    Object.assign(child, {
      stdin,
      stdout,
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
      kill(signal: NodeJS.Signals = 'SIGTERM') {
        if (child.exitCode !== null || child.signalCode !== null) return true;
        Object.assign(child, { signalCode: signal });
        stdout.end();
        setImmediate(() => child.emit('close', null, signal));
        return true;
      },
    });
    if (spawned.length === 0) {
      // The encoder: exits 0 once its input ends.
      stdin.on('data', (b: Buffer) => encoderInput.push(b));
      stdin.on('finish', () => {
        Object.assign(child, { exitCode: 0 });
        setImmediate(() => child.emit('close', 0, null));
      });
    }
    spawned.push({ file, args, child });
    return child;
  };
  return { spawnImpl, spawned, encoderInput };
}

/** A stereo s16le buffer of `frames` frames, all samples = `value`. */
function pcm(frames: number, value = 1000): Buffer {
  const b = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames * 2; i += 1) b.writeInt16LE(value, i * 2);
  return b;
}

/** The left-channel sample of every frame. */
function leftSamples(buffers: Buffer[]): number[] {
  const all = Buffer.concat(buffers);
  const out: number[] = [];
  for (let i = 0; i < all.length; i += 4) out.push(all.readInt16LE(i));
  return out;
}

describe('pw-record command (§9.5)', () => {
  it('captures the default sink monitor as raw s16 48 kHz stereo on stdout', () => {
    expect(pwRecordCommand()).toEqual({
      file: 'pw-record',
      args: [
        '-a',
        '-P',
        '{ stream.capture.sink=true }',
        '--rate',
        '48000',
        '--channels',
        '2',
        '--format',
        's16',
        '-',
      ],
    });
  });

  it('encodes Opus into ≤1 s fMP4 fragments', () => {
    const args = opusEncoderArgs('/p/media/system.rec.mp4');
    expect(args.join(' ')).toContain('-f s16le -ar 48000 -ac 2 -i pipe:0 -c:a libopus');
    expect(args.join(' ')).toContain(
      '-frag_duration 1000000 -movflags +empty_moov+default_base_moof',
    );
    expect(args.at(-1)).toBe('/p/media/system.rec.mp4');
  });
});

describe('PcmIngest (unit, fake processes)', () => {
  it('stamps chunks on arrival, keeps frame alignment and writes checkpoints', async () => {
    const fake = fakeSpawn();
    const firsts: number[] = [];
    const ingest = new PcmIngest({
      ffmpegPath: 'ffmpeg',
      dir,
      spawnImpl: fake.spawnImpl,
      onFirstAudio: (us) => firsts.push(us),
    });
    expect(fake.spawned.map((s) => s.file)).toEqual(['ffmpeg', 'pw-record']);

    // 4800 frames (100 ms) arriving at t = 10 s: the first frame was captured at 9.9 s.
    ingest.onPcm(pcm(4800), 10_000_000);
    // A chunk that splits a frame: 2 bytes are carried to the next chunk.
    const odd = pcm(480);
    ingest.onPcm(odd.subarray(0, 1918), 10_010_000);
    ingest.onPcm(odd.subarray(1918), 10_020_000);
    // 1 s later: a new checkpoint.
    ingest.onPcm(pcm(48_000), 11_020_000);

    const result = await ingest.stop();
    expect(firsts).toEqual([9_900_000]);
    expect(result).toMatchObject({
      samples: 4800 + 480 + 48_000,
      silencedSamples: 0,
      firstSampleUs: 9_900_000,
      checkpoints: 2,
      path: path.join(dir, 'system.rec.mp4'),
    });
    expect(leftSamples(fake.encoderInput)).toHaveLength(result.samples);
    const sync = JSON.parse(await fs.readFile(result.syncPath, 'utf8')) as unknown;
    expect(sync).toEqual({
      version: 1,
      nominalRate: 48000,
      checkpoints: [
        [10_000_000, 4800],
        [11_020_000, 53_280],
      ],
    });
    // pw-record got SIGINT.
    expect(fake.spawned[1]!.child.signalCode).toBe('SIGINT');
  });

  it('replaces exactly the paused span with silence (R1.14)', async () => {
    const fake = fakeSpawn();
    const ingest = new PcmIngest({ ffmpegPath: 'ffmpeg', dir, spawnImpl: fake.spawnImpl });
    // Chunk of 480 frames (10 ms) per 10 ms; frame k of a chunk arriving at A is at A − (480 − k)·20.833 µs.
    ingest.onPcm(pcm(480), 1_010_000); // frames at [1.000 s, 1.010 s)
    ingest.pause(1_015_000);
    expect(ingest.paused).toBe(true);
    ingest.onPcm(pcm(480), 1_020_000); // [1.010, 1.020): frames from 1.015 s silenced
    ingest.onPcm(pcm(480), 1_030_000); // fully paused
    ingest.resume(1_035_000);
    ingest.onPcm(pcm(480), 1_040_000); // [1.030, 1.040): first half silenced
    ingest.onPcm(pcm(480), 1_050_000); // live again
    const result = await ingest.stop();

    const left = leftSamples(fake.encoderInput);
    expect(left).toHaveLength(5 * 480);
    const zeroAt = left.map((v) => v === 0);
    expect(zeroAt.slice(0, 480).some(Boolean)).toBe(false);
    expect(zeroAt.slice(480, 720).some(Boolean)).toBe(false);
    expect(zeroAt.slice(720, 1440).every(Boolean)).toBe(true);
    expect(zeroAt.slice(1440, 1680).every(Boolean)).toBe(true);
    expect(zeroAt.slice(1680).some(Boolean)).toBe(false);
    expect(result.silencedSamples).toBe(240 + 480 + 240);
    expect(result.samples).toBe(2400);
  });

  it('reports a capture process that dies early', async () => {
    const fake = fakeSpawn();
    const errors: string[] = [];
    const ingest = new PcmIngest({
      ffmpegPath: 'ffmpeg',
      dir,
      spawnImpl: fake.spawnImpl,
      onError: (m) => errors.push(m),
    });
    const capture = fake.spawned[1]!.child;
    Object.assign(capture, { exitCode: 1 });
    capture.emit('close', 1, null);
    await new Promise((r) => setImmediate(r));
    expect(errors[0]).toContain('pw-record exited early (1)');
    const result = await ingest.stop();
    expect(result.exitCode).toBe(1);
  });
});

describe('system audio levels (R1.5, R1.12)', () => {
  it('measures the linear peak of s16le samples', () => {
    expect(peakOfS16(pcm(10, 16384))).toBeCloseTo(0.5);
    expect(peakOfS16(pcm(10, -32768))).toBe(1);
    expect(peakOfS16(pcm(10, 0))).toBe(0);
  });

  it('hands out one peak per interval (about 15 Hz)', () => {
    const levels: number[] = [];
    const tracker = new LevelTracker((p) => levels.push(p), 66_667);
    tracker.offer(pcm(10, 1000), 0);
    tracker.offer(pcm(10, 8000), 30_000);
    tracker.offer(pcm(10, 2000), 70_000);
    tracker.offer(pcm(10, 100), 100_000);
    expect(levels.map((l) => Math.round(l * 32768))).toEqual([1000, 8000]);
  });

  it('reports the level of what is written, so paused audio reads as silence', async () => {
    const fake = fakeSpawn();
    const levels: number[] = [];
    const ingest = new PcmIngest({
      ffmpegPath: 'ffmpeg',
      dir,
      spawnImpl: fake.spawnImpl,
      onLevel: (p) => levels.push(p),
    });
    ingest.onPcm(pcm(480, 16384), 1_010_000);
    ingest.pause(1_015_000);
    ingest.onPcm(pcm(480, 16384), 1_200_000);
    await ingest.stop();
    expect(levels[0]).toBeCloseTo(0.5);
    expect(levels[1]).toBe(0);
  });

  it('runs a capture-only monitor for the setup panel and stops it with SIGINT', () => {
    const fake = fakeSpawn();
    const levels: number[] = [];
    let now = 0;
    const monitor = new SystemAudioMonitor({
      onLevel: (p) => levels.push(p),
      spawnImpl: fake.spawnImpl,
      nowUs: () => (now += 100_000),
    });
    expect(fake.spawned).toHaveLength(1);
    expect(fake.spawned[0]!.file).toBe('pw-record');
    (fake.spawned[0]!.child.stdout as PassThrough).write(pcm(100, 8192));
    expect(levels[0]).toBeCloseTo(0.25);
    monitor.stop();
    expect(fake.spawned[0]!.child.signalCode).toBe('SIGINT');
  });
});
