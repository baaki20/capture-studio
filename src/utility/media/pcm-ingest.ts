/**
 * System audio on Linux, strategy (b) (§4.3.2, §9.5): `pw-record` captures the default sink's
 * monitor as raw s16le 48 kHz stereo on stdout; the bundled FFmpeg encodes it to Opus in
 * fragmented MP4 (`system.rec.mp4`, ≤1 s fragments).
 *
 * - Timing is arrival-calibrated: each chunk is stamped on arrival with
 *   `performance.timeOrigin + performance.now()` (µs), and about once a second a drift
 *   checkpoint `[arrivalUs, cumulativeSamples]` goes to `system.sync.json` (§1.5, §4.4.3): the
 *   chunk of that second that arrived earliest relative to its samples (`CheckpointLog`).
 * - Pause keeps the stream linear: samples whose estimated capture time falls inside a pause are
 *   replaced by digital silence, so nothing from the paused span is stored (§1.5, R1.14).
 * - Stop sends SIGINT to the capture process, lets FFmpeg finish the last fragment, and writes
 *   the final checkpoints.
 * - The peak of what is written is reported at about 15 Hz (`onLevel`) for the live meters
 *   (R1.12). `SystemAudioMonitor` runs the same capture without a file, for the setup panel's
 *   meter (R1.5).
 */
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { SyncCheckpoints, SystemAudioResult } from '../../shared/ipc/media-utility';
import type { Logger } from '../../shared/logger';
import { CheckpointLog } from '../../shared/recording/drift';
import { silentLogger } from '../../shared/logger';
import { spawnChild } from './child-processes';
import { writeJsonAtomic } from './fs-utils';
import { DEFAULT_FSYNC_INTERVAL_MS, utilityNowUs } from './stream-writer';

export const SYSTEM_SAMPLE_RATE = 48_000;
export const SYSTEM_CHANNELS = 2;
const BYTES_PER_FRAME = 2 * SYSTEM_CHANNELS;
const US_PER_SECOND = 1_000_000;
/** Meter updates at about 15 Hz (R1.12 asks for at least 10). */
export const LEVEL_INTERVAL_US = US_PER_SECOND / 15;

export const SYSTEM_FILE_NAME = 'system.rec.mp4';
export const SYSTEM_SYNC_FILE_NAME = 'system.sync.json';

export interface CaptureCommand {
  file: string;
  args: string[];
}

/**
 * `-a` (raw mode) is needed: without it `pw-record … -` puts an AU header on stdout. The format
 * is pinned to s16 so the byte layout never depends on pw-record's defaults.
 */
export function pwRecordCommand(): CaptureCommand {
  return {
    file: 'pw-record',
    args: [
      '-a',
      '-P',
      '{ stream.capture.sink=true }',
      '--rate',
      String(SYSTEM_SAMPLE_RATE),
      '--channels',
      String(SYSTEM_CHANNELS),
      '--format',
      's16',
      '-',
    ],
  };
}

export function opusEncoderArgs(output: string, bitrate = '128k'): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    's16le',
    '-ar',
    String(SYSTEM_SAMPLE_RATE),
    '-ac',
    String(SYSTEM_CHANNELS),
    '-i',
    'pipe:0',
    '-c:a',
    'libopus',
    '-b:a',
    bitrate,
    // ≤1 s fragments, each written out as soon as it is complete (§1.5, §9.6).
    '-frag_duration',
    String(US_PER_SECOND),
    '-movflags',
    '+empty_moov+default_base_moof',
    '-flush_packets',
    '1',
    '-f',
    'mp4',
    '-y',
    output,
  ];
}

export interface PcmIngestOptions {
  ffmpegPath: string;
  /** The project's `media/` folder. */
  dir: string;
  /** Replaces `pw-record` (tests feed a synthetic PCM source). */
  command?: CaptureCommand;
  nowUs?: () => number;
  logger?: Logger;
  spawnImpl?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  bitrate?: string;
  checkpointIntervalUs?: number;
  /** How often `system.sync.json` is rewritten while recording. Default 5000 ms. */
  syncWriteIntervalMs?: number;
  fsyncIntervalMs?: number;
  onFirstAudio?: (firstSampleUs: number) => void;
  /** The capture or encoder process failed; the stream has ended early. */
  onError?: (message: string) => void;
  /** Linear peak (0–1) of the samples written since the previous call, at about 15 Hz. */
  onLevel?: (peak: number) => void;
}

/** Linear peak (0–1) of interleaved s16le samples. */
export function peakOfS16(pcm: Buffer): number {
  let peak = 0;
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    const value = Math.abs(pcm.readInt16LE(offset));
    if (value > peak) peak = value;
  }
  return Math.min(1, peak / 32768);
}

/** Accumulates chunk peaks and hands one out per interval. */
export class LevelTracker {
  private peak = 0;
  private lastUs = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly onLevel: (peak: number) => void,
    private readonly intervalUs = LEVEL_INTERVAL_US,
  ) {}

  offer(pcm: Buffer, nowUs: number): void {
    const peak = peakOfS16(pcm);
    if (peak > this.peak) this.peak = peak;
    if (nowUs - this.lastUs < this.intervalUs) return;
    this.lastUs = nowUs;
    this.onLevel(this.peak);
    this.peak = 0;
  }
}

interface PauseSpan {
  startUs: number;
  endUs: number | null;
}

const STDERR_TAIL = 8 * 1024;

export class PcmIngest {
  readonly path: string;
  readonly syncPath: string;

  private readonly capture: ChildProcess;
  private readonly encoder: ChildProcess;
  private readonly nowUs: () => number;
  private readonly logger: Logger;
  private readonly checkpointLog: CheckpointLog;
  private readonly pauses: PauseSpan[] = [];
  private readonly timers: ReturnType<typeof setInterval>[] = [];

  private carry: Buffer = Buffer.alloc(0);
  private samples = 0;
  private silencedSamples = 0;
  private firstSampleUs: number | null = null;
  private captureStderr = '';
  private encoderStderr = '';
  private failed: string | null = null;
  private stopping = false;
  private syncWriting: Promise<void> = Promise.resolve();
  private readonly captureExited: Promise<number | null>;
  private readonly encoderExited: Promise<number | null>;
  private result: Promise<SystemAudioResult> | null = null;
  private readonly levels: LevelTracker | null;

  constructor(private readonly options: PcmIngestOptions) {
    this.levels = options.onLevel ? new LevelTracker(options.onLevel) : null;
    this.path = path.join(options.dir, SYSTEM_FILE_NAME);
    this.syncPath = path.join(options.dir, SYSTEM_SYNC_FILE_NAME);
    this.nowUs = options.nowUs ?? utilityNowUs;
    this.logger = options.logger ?? silentLogger;
    this.checkpointLog = new CheckpointLog(
      SYSTEM_SAMPLE_RATE,
      options.checkpointIntervalUs ?? US_PER_SECOND,
    );
    const command = options.command ?? pwRecordCommand();

    // Both children are tracked and die with this process, even on SIGKILL (child-processes.ts).
    this.encoder = spawnChild(
      options.ffmpegPath,
      opusEncoderArgs(this.path, options.bitrate),
      { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true },
      options.spawnImpl,
    );
    this.encoderExited = exitOf(this.encoder);
    this.encoder.stderr?.setEncoding('utf8');
    this.encoder.stderr?.on('data', (chunk: string) => {
      this.encoderStderr = (this.encoderStderr + chunk).slice(-STDERR_TAIL);
    });
    // EPIPE after the encoder died is reported through its exit instead.
    this.encoder.stdin?.on('error', () => undefined);
    void this.encoderExited.then((code) => {
      if (!this.stopping)
        this.fail(`encoder exited early (${String(code)}): ${this.encoderStderr.trim()}`);
    });

    this.capture = spawnChild(
      command.file,
      command.args,
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      options.spawnImpl,
    );
    this.captureExited = exitOf(this.capture);
    this.capture.stderr?.setEncoding('utf8');
    this.capture.stderr?.on('data', (chunk: string) => {
      this.captureStderr = (this.captureStderr + chunk).slice(-STDERR_TAIL);
    });
    this.capture.stdout?.on('data', (chunk: Buffer) => this.onPcm(chunk, this.nowUs()));
    this.capture.stdout?.on('end', () => this.endEncoderInput());
    void this.captureExited.then((code) => {
      if (!this.stopping) {
        this.fail(`${command.file} exited early (${String(code)}): ${this.captureStderr.trim()}`);
      }
    });

    this.timers.push(
      setInterval(() => this.queueSyncWrite(), options.syncWriteIntervalMs ?? 5000),
      setInterval(() => this.fsyncOutput(), options.fsyncIntervalMs ?? DEFAULT_FSYNC_INTERVAL_MS),
    );
    for (const timer of this.timers) timer.unref();
  }

  /** Silences audio captured from `atUs` (utility clock; default now) until `resume`. */
  pause(atUs: number = this.nowUs()): void {
    const open = this.pauses.at(-1);
    if (open?.endUs === null) return;
    this.pauses.push({ startUs: atUs, endUs: null });
  }

  resume(atUs: number = this.nowUs()): void {
    const open = this.pauses.at(-1);
    if (open?.endUs === null) open.endUs = Math.max(atUs, open.startUs);
  }

  get paused(): boolean {
    return this.pauses.at(-1)?.endUs === null;
  }

  /** Stops capture (SIGINT), waits for the encoder to finish, and writes the final checkpoints. */
  stop(timeoutMs = 10_000): Promise<SystemAudioResult> {
    this.result ??= this.finish(timeoutMs);
    return this.result;
  }

  private async finish(timeoutMs: number): Promise<SystemAudioResult> {
    this.stopping = true;
    if (this.capture.exitCode === null && this.capture.signalCode === null) {
      this.capture.kill('SIGINT');
    }
    const captureCode = await withTimeout(this.captureExited, 3000, () =>
      this.capture.kill('SIGKILL'),
    );
    this.endEncoderInput();
    const encoderCode = await withTimeout(this.encoderExited, timeoutMs, () =>
      this.encoder.kill('SIGKILL'),
    );
    for (const timer of this.timers) clearInterval(timer);
    if (encoderCode !== 0 && !this.failed) {
      this.failed = `encoder exited with ${String(encoderCode)}: ${this.encoderStderr.trim()}`;
    }
    this.fsyncOutput();
    this.checkpointLog.flush();
    this.queueSyncWrite();
    await this.syncWriting;
    if (this.failed) this.logger.warn(`pcm-ingest: ${this.failed}`);

    return {
      path: this.path,
      syncPath: this.syncPath,
      samples: this.samples,
      silencedSamples: this.silencedSamples,
      firstSampleUs: this.firstSampleUs,
      checkpoints: this.checkpointLog.checkpoints.length,
      exitCode: captureCode,
    };
  }

  /** Handles one stdout chunk that arrived at `arrivalUs`. Exposed for tests. */
  onPcm(chunk: Buffer, arrivalUs: number): void {
    const data = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    const frames = Math.floor(data.length / BYTES_PER_FRAME);
    const usable = frames * BYTES_PER_FRAME;
    this.carry = Buffer.from(data.subarray(usable));
    if (frames === 0) return;

    const pcm = Buffer.from(data.subarray(0, usable));
    // The last frame of the chunk is taken to have been captured at arrival.
    const firstUs = arrivalUs - (frames * US_PER_SECOND) / SYSTEM_SAMPLE_RATE;
    if (this.firstSampleUs === null) {
      this.firstSampleUs = firstUs;
      this.options.onFirstAudio?.(firstUs);
    }
    this.silencedSamples += this.silencePaused(pcm, frames, firstUs);
    this.samples += frames;

    this.checkpointLog.offer(arrivalUs, this.samples);
    this.levels?.offer(pcm, arrivalUs);
    if (!this.failed) this.encoder.stdin?.write(pcm);
  }

  /** Zeroes the frames whose capture time lies in a pause span. Returns how many. */
  private silencePaused(pcm: Buffer, frames: number, firstUs: number): number {
    if (this.pauses.length === 0) return 0;
    const frameUs = US_PER_SECOND / SYSTEM_SAMPLE_RATE;
    const lastUs = firstUs + (frames - 1) * frameUs;
    let silenced = 0;
    for (const span of this.pauses) {
      const endUs = span.endUs ?? Number.POSITIVE_INFINITY;
      if (endUs <= firstUs || span.startUs > lastUs) continue;
      const from = Math.max(0, Math.ceil((span.startUs - firstUs) / frameUs));
      const to = Math.min(frames, Math.ceil((endUs - firstUs) / frameUs));
      if (to <= from) continue;
      pcm.fill(0, from * BYTES_PER_FRAME, to * BYTES_PER_FRAME);
      silenced += to - from;
    }
    return Math.min(silenced, frames);
  }

  private endEncoderInput(): void {
    const stdin = this.encoder.stdin;
    if (!stdin || stdin.writableEnded) return;
    // A trailing partial frame cannot be encoded; it is dropped.
    stdin.end();
  }

  private fail(message: string): void {
    if (this.failed) return;
    this.failed = message;
    this.options.onError?.(message);
    if (this.capture.exitCode === null && this.capture.signalCode === null)
      this.capture.kill('SIGINT');
    this.endEncoderInput();
  }

  private fsyncOutput(): void {
    let fd: number | null = null;
    try {
      // fsync flushes the file's data whichever descriptor is used (FFmpeg owns the writer).
      fd = fs.openSync(this.path, 'r');
      fs.fsyncSync(fd);
    } catch {
      // Not created yet.
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }

  private queueSyncWrite(): void {
    const doc: SyncCheckpoints = {
      version: 1,
      nominalRate: SYSTEM_SAMPLE_RATE,
      checkpoints: this.checkpointLog.checkpoints.map(([us, n]) => [us, n]),
    };
    const run = async (): Promise<void> => {
      try {
        await writeJsonAtomic(this.syncPath, doc);
      } catch (error) {
        this.logger.warn(`pcm-ingest: writing ${this.syncPath} failed`, error);
      }
    };
    this.syncWriting = this.syncWriting.then(run, run);
  }
}

export interface SystemAudioMonitorOptions {
  onLevel: (peak: number) => void;
  /** Replaces `pw-record` (tests). */
  command?: CaptureCommand;
  nowUs?: () => number;
  logger?: Logger;
  spawnImpl?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
}

/**
 * The setup panel's system-audio meter (R1.5): the same `pw-record` capture as recording, with
 * its PCM only measured, never written.
 */
export class SystemAudioMonitor {
  private readonly capture: ChildProcess;

  constructor(options: SystemAudioMonitorOptions) {
    const command = options.command ?? pwRecordCommand();
    const nowUs = options.nowUs ?? utilityNowUs;
    const levels = new LevelTracker(options.onLevel);
    this.capture = spawnChild(
      command.file,
      command.args,
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
      options.spawnImpl,
    );
    this.capture.once('error', (error) =>
      (options.logger ?? silentLogger).warn(`system monitor: ${error.message}`),
    );
    this.capture.stdout?.on('data', (chunk: Buffer) => levels.offer(chunk, nowUs()));
  }

  stop(): void {
    if (this.capture.exitCode === null && this.capture.signalCode === null) {
      this.capture.kill('SIGINT');
    }
  }
}

function exitOf(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    child.once('error', () => resolve(null));
    child.once('close', (code) => resolve(code));
  });
}

async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      onTimeout();
      resolve();
    }, ms);
  });
  await Promise.race([promise, timeout]);
  clearTimeout(timer);
  return promise;
}
