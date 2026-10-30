import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  createProgressParser,
  ffmpegTooOldError,
  filterComplexArgs,
  runFfmpeg,
  RUNNER_GLOBAL_ARGS,
  type FfmpegProgress,
} from '../../src/utility/media/ffmpeg-runner';
import { parseFfmpegVersion } from '../../src/utility/media/probe';

const BLOCK = (outTimeUs: string, progress: string) =>
  `frame=12\nfps=24.0\nout_time_us=${outTimeUs}\nout_time=00:00:00.500000\nspeed=1.5x\nprogress=${progress}\n`;

describe('createProgressParser', () => {
  it('emits one event per block with fraction of the expected duration', () => {
    const events: FfmpegProgress[] = [];
    const feed = createProgressParser(2_000_000, (p) => events.push(p));
    feed(BLOCK('500000', 'continue'));
    feed(BLOCK('2000000', 'end'));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      outTimeUs: 500_000,
      fraction: 0.25,
      speed: 1.5,
      frame: 12,
      done: false,
    });
    expect(events[1]).toMatchObject({ fraction: 1, done: true });
  });

  it('handles blocks split across chunks and N/A values', () => {
    const events: FfmpegProgress[] = [];
    const feed = createProgressParser(undefined, (p) => events.push(p));
    const text =
      'frame=0\nout_time_us=N/A\nout_time=00:01:02.250000\nspeed=N/A\nprogress=continue\n';
    for (const ch of text) feed(ch);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outTimeUs: 62_250_000,
      fraction: null,
      speed: null,
      frame: 0,
    });
  });

  it('clamps the fraction to [0, 1]', () => {
    const events: FfmpegProgress[] = [];
    const feed = createProgressParser(1_000_000, (p) => events.push(p));
    feed('out_time_us=3000000\nprogress=continue\nout_time_us=-5\nprogress=continue\n');
    expect(events.map((e) => e.fraction)).toEqual([1, 0]);
  });
});

describe('filterComplexArgs (§1.10, §9.7)', () => {
  it('always passes the graph with -/filter_complex, never -filter_complex_script', () => {
    expect(filterComplexArgs('g.txt')).toEqual(['-/filter_complex', 'g.txt']);
  });

  it('refuses FFmpeg older than 7.1 with a clear error', () => {
    const v = (version: string) => parseFfmpegVersion(`ffmpeg version ${version} Copyright`);
    expect(ffmpegTooOldError(v('n9.0.2-35-g9a9b70bb8c-20261023'))).toBeNull();
    expect(ffmpegTooOldError(v('7.1.1'))).toBeNull();
    expect(ffmpegTooOldError(v('N-127957-g935f29eaae-20261023'))).toBeNull();
    expect(ffmpegTooOldError(null)).toBeNull();
    for (const old of ['7.0.2', '6.1.1', 'n4.4.2']) {
      const message = ffmpegTooOldError(v(old));
      expect(message).toContain(`FFmpeg ${old} is too old`);
      expect(message).toContain('7.1 or later');
    }
  });
});

describe('parseFfmpegVersion', () => {
  it('parses release-branch, tagged and master builds', () => {
    expect(
      parseFfmpegVersion('ffmpeg version n9.0.2-35-g9a9b70bb8c-20261023 Copyright (c) 2000-2026'),
    ).toMatchObject({
      version: 'n9.0.2-35-g9a9b70bb8c-20261023',
      release: { major: 9, minor: 0 },
    });
    expect(parseFfmpegVersion('ffprobe version 7.1.1 Copyright')?.release).toEqual({
      major: 7,
      minor: 1,
    });
    expect(
      parseFfmpegVersion('ffmpeg version N-127957-g935f29eaae-20261023 Copyright')?.release,
    ).toBeNull();
    expect(parseFfmpegVersion('something else')).toBeNull();
  });
});

/** A fake child process: records stdin, exits when told to. */
function fakeChild() {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const written: string[] = [];
  stdin.on('data', (d: Buffer) => written.push(d.toString()));
  const kill = vi.fn((signal: string) => {
    setImmediate(() => emitter.emit('close', null, signal));
    return true;
  });
  const child = Object.assign(emitter, { stdin, stdout, stderr, kill }) as unknown as ChildProcess;
  return { child, stdout, stderr, kill, written };
}

describe('runFfmpeg', () => {
  it('passes global progress arguments and resolves on success', async () => {
    const { child, stdout, stderr } = fakeChild();
    const spawnImpl = vi.fn((_command: string, _args: readonly string[]) => child);
    const progress: FfmpegProgress[] = [];
    const promise = runFfmpeg({
      ffmpegPath: '/x/ffmpeg',
      args: ['-i', 'in.mp4', 'out.mp4'],
      durationUs: 1_000_000,
      onProgress: (p) => progress.push(p),
      spawnImpl,
    });
    stdout.write(BLOCK('1000000', 'end'));
    stderr.write('some log');
    setImmediate(() => child.emit('close', 0, null));
    expect(await promise).toEqual({ ok: true, value: { stderrTail: 'some log' } });
    expect(spawnImpl.mock.calls[0]?.[1]).toEqual([
      ...RUNNER_GLOBAL_ARGS,
      '-i',
      'in.mp4',
      'out.mp4',
    ]);
    expect(progress.at(-1)?.done).toBe(true);
  });

  it('reports failures with the stderr tail', async () => {
    const { child, stderr } = fakeChild();
    const promise = runFfmpeg({ ffmpegPath: 'ffmpeg', args: [], spawnImpl: () => child });
    stderr.write('Invalid argument');
    setImmediate(() => child.emit('close', 1, null));
    expect(await promise).toEqual({
      ok: false,
      error: { kind: 'failed', exitCode: 1, signal: null, stderrTail: 'Invalid argument' },
    });
  });

  it('cancels with q first, then SIGKILL after the timeout', async () => {
    const { child, kill, written } = fakeChild();
    const controller = new AbortController();
    const promise = runFfmpeg({
      ffmpegPath: 'ffmpeg',
      args: [],
      signal: controller.signal,
      killTimeoutMs: 20,
      spawnImpl: () => child,
    });
    controller.abort();
    expect(await promise).toEqual({ ok: false, error: { kind: 'cancelled' } });
    expect(written.join('')).toBe('q');
    expect(kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('does not spawn when already aborted', async () => {
    const spawnImpl = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const result = await runFfmpeg({
      ffmpegPath: 'ffmpeg',
      args: [],
      signal: controller.signal,
      spawnImpl,
    });
    expect(result).toEqual({ ok: false, error: { kind: 'cancelled' } });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('reports spawn errors', async () => {
    const { child } = fakeChild();
    const promise = runFfmpeg({ ffmpegPath: '/missing', args: [], spawnImpl: () => child });
    setImmediate(() => child.emit('error', new Error('spawn /missing ENOENT')));
    expect(await promise).toEqual({
      ok: false,
      error: { kind: 'spawn-failed', message: 'spawn /missing ENOENT' },
    });
  });
});
