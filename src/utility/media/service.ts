/**
 * The media utility's request dispatcher, separate from the process entry so it can be tested
 * without Electron. It owns the open stream writers, system-audio captures and running jobs
 * (finalize, peaks, thumbnails, the encoder probe and exports).
 */
import { promises as fs } from 'node:fs';
import type { StreamKind } from '../../shared/ipc/contract';
import {
  JOB_RESULT_SCHEMAS,
  MediaUtilityRequestSchema,
  type JobSpec,
  type MediaUtilityEvent,
} from '../../shared/ipc/media-utility';
import type { Logger } from '../../shared/logger';
import { silentLogger } from '../../shared/logger';
import { probeEncoders } from './encoder-probe';
import { runExportJob } from './export/export-job';
import { finalizeRecording } from './finalize';
import { PcmIngest, SystemAudioMonitor } from './pcm-ingest';
import { ffmpegTooOldError } from './ffmpeg-runner';
import { generatePeaks } from './peaks';
import { probeFfmpegVersion, type FfmpegVersion } from './probe';
import {
  attachClockPort,
  attachStreamPort,
  StreamWriter,
  utilityNowUs,
  type AttachedStream,
  type PortLike,
} from './stream-writer';
import { generateThumbnails } from './thumbnails';

const STATS_INTERVAL_MS = 1000;

export interface MediaServiceOptions {
  emit: (event: MediaUtilityEvent) => void;
  logger?: Logger;
  nowUs?: () => number;
}

export class MediaService {
  private ffmpeg: {
    ffmpegPath: string;
    ffprobePath: string;
    version: FfmpegVersion | null;
  } | null = null;
  private readonly streams = new Map<string, AttachedStream>();
  private readonly systems = new Map<string, PcmIngest>();
  private monitor: SystemAudioMonitor | null = null;
  private readonly jobs = new Map<string, AbortController>();
  private readonly statsTimer: ReturnType<typeof setInterval>;
  private readonly logger: Logger;
  private readonly nowUs: () => number;

  constructor(private readonly options: MediaServiceOptions) {
    this.logger = options.logger ?? silentLogger;
    this.nowUs = options.nowUs ?? utilityNowUs;
    this.statsTimer = setInterval(() => this.emitStats(), STATS_INTERVAL_MS);
    this.statsTimer.unref();
  }

  /** Validates and handles one request from main. Returns false for a rejected message. */
  async handle(message: unknown, ports: readonly PortLike[] = []): Promise<boolean> {
    const parsed = MediaUtilityRequestSchema.safeParse(message);
    if (!parsed.success) {
      this.logger.error('media utility: rejected malformed request', parsed.error.issues);
      for (const port of ports) port.close();
      return false;
    }
    const request = parsed.data;
    switch (request.type) {
      case 'init': {
        const version = await probeFfmpegVersion(request.ffmpegPath);
        this.ffmpeg = {
          ffmpegPath: request.ffmpegPath,
          ffprobePath: request.ffprobePath,
          version: version.ok ? version.value : null,
        };
        this.emit(
          version.ok
            ? {
                type: 'ready',
                ffmpegVersion: version.value.version,
                error: ffmpegTooOldError(version.value),
              }
            : { type: 'ready', ffmpegVersion: null, error: version.error.message },
        );
        break;
      }
      case 'ping':
        this.emit({ type: 'pong', id: request.id, pid: process.pid });
        break;
      case 'clock.ping':
        this.emit({
          type: 'clock.pong',
          id: request.id,
          sentUs: request.sentUs,
          utilityUs: this.nowUs(),
        });
        break;

      case 'stream.open':
        this.openStream(request.streamId, request.kind, request.dir, ports[0]);
        break;
      case 'stream.close': {
        const stream = this.streams.get(request.streamId);
        if (stream) stream.close();
        break;
      }
      case 'clock.attach':
        if (ports[0]) attachClockPort(ports[0], this.nowUs);
        else this.logger.error('media utility: clock.attach without a port');
        break;

      case 'system.start':
        await this.startSystem(request.captureId, request.dir, request.command);
        break;
      case 'system.pause':
        this.systems.get(request.captureId)?.pause(request.atUs);
        break;
      case 'system.resume':
        this.systems.get(request.captureId)?.resume(request.atUs);
        break;
      case 'system.stop': {
        const ingest = this.systems.get(request.captureId);
        if (!ingest) break;
        const result = await ingest.stop();
        this.systems.delete(request.captureId);
        this.emit({ type: 'system.stopped', captureId: request.captureId, result });
        break;
      }

      case 'system.monitor':
        this.setMonitor(request.enabled);
        break;
      case 'job':
        await this.runJob(request.jobId, request.job);
        break;
      case 'job.cancel':
        this.jobs.get(request.jobId)?.abort();
        break;
    }
    return true;
  }

  /** Flushes and closes everything (process shutdown). */
  async shutdown(): Promise<void> {
    clearInterval(this.statsTimer);
    this.setMonitor(false);
    for (const stream of this.streams.values()) stream.close();
    this.streams.clear();
    for (const job of this.jobs.values()) job.abort();
    await Promise.all([...this.systems.values()].map((s) => s.stop()));
    this.systems.clear();
  }

  private setMonitor(enabled: boolean): void {
    if (!enabled) {
      this.monitor?.stop();
      this.monitor = null;
      return;
    }
    this.monitor ??= new SystemAudioMonitor({
      nowUs: this.nowUs,
      logger: this.logger,
      onLevel: (peak) => this.emit({ type: 'system.level', captureId: null, peak }),
    });
  }

  private emit(event: MediaUtilityEvent): void {
    this.options.emit(event);
  }

  private emitStats(): void {
    for (const [streamId, stream] of this.streams) {
      this.emit({ type: 'stream.stats', streamId, stats: stream.writer.stats() });
    }
  }

  private openStream(
    streamId: string,
    kind: StreamKind,
    dir: string,
    port: PortLike | undefined,
  ): void {
    if (!port) {
      this.emit({ type: 'stream.error', streamId, message: 'stream.open without a port' });
      return;
    }
    if (this.streams.has(streamId)) {
      port.close();
      this.emit({ type: 'stream.error', streamId, message: 'stream id already open' });
      return;
    }
    let writer: StreamWriter;
    try {
      writer = new StreamWriter({ dir, kind, logger: this.logger });
    } catch (error) {
      port.close();
      this.emit({ type: 'stream.error', streamId, message: `cannot open file: ${String(error)}` });
      return;
    }
    const attached = attachStreamPort(port, writer, {
      nowUs: this.nowUs,
      logger: this.logger,
      onClosed: (stats) => {
        this.streams.delete(streamId);
        this.emit({ type: 'stream.closed', streamId, stats });
      },
      onError: (message) => this.emit({ type: 'stream.error', streamId, message }),
    });
    this.streams.set(streamId, attached);
    this.emit({ type: 'stream.opened', streamId, path: writer.path });
  }

  private async startSystem(
    captureId: string,
    dir: string,
    command: { file: string; args: string[] } | undefined,
  ): Promise<void> {
    if (!this.ffmpeg) {
      this.emit({ type: 'system.error', captureId, message: 'FFmpeg is not available' });
      return;
    }
    if (this.systems.has(captureId)) {
      this.emit({ type: 'system.error', captureId, message: 'capture id already running' });
      return;
    }
    await fs.mkdir(dir, { recursive: true });
    const ingest = new PcmIngest({
      ffmpegPath: this.ffmpeg.ffmpegPath,
      dir,
      ...(command ? { command } : {}),
      nowUs: this.nowUs,
      logger: this.logger,
      onFirstAudio: (firstSampleUs) =>
        this.emit({ type: 'system.first-audio', captureId, firstSampleUs }),
      onError: (message) => this.emit({ type: 'system.error', captureId, message }),
      onLevel: (peak) => this.emit({ type: 'system.level', captureId, peak }),
    });
    this.systems.set(captureId, ingest);
    this.emit({ type: 'system.started', captureId, path: ingest.path });
  }

  private async runJob(jobId: string, job: JobSpec): Promise<void> {
    if (this.jobs.has(jobId)) {
      this.emit({ type: 'job.error', jobId, message: 'job id already running', cancelled: false });
      return;
    }
    const ffmpeg = this.ffmpeg;
    if (!ffmpeg) {
      this.emit({ type: 'job.error', jobId, message: 'FFmpeg is not available', cancelled: false });
      return;
    }
    const controller = new AbortController();
    this.jobs.set(jobId, controller);
    const { signal } = controller;
    const progress = (fraction: number | null): void =>
      this.emit({ type: 'job.progress', jobId, fraction });

    try {
      let result: unknown;
      switch (job.kind) {
        case 'finalize':
          result = {
            streams: await finalizeRecording({
              ffmpegPath: ffmpeg.ffmpegPath,
              ffprobePath: ffmpeg.ffprobePath,
              dir: job.dir,
              streams: job.streams,
              recovering: job.recovering,
              signal,
              onProgress: progress,
            }),
          };
          break;
        case 'peaks':
          result = await generatePeaks({
            ffmpegPath: ffmpeg.ffmpegPath,
            input: job.input,
            output: job.output,
            signal,
          });
          break;
        case 'thumbnails':
          result = await generateThumbnails({
            ffmpegPath: ffmpeg.ffmpegPath,
            ffprobePath: ffmpeg.ffprobePath,
            input: job.input,
            outDir: job.outDir,
            mediaId: job.mediaId,
            signal,
            onProgress: progress,
          });
          break;
        case 'encoders.probe':
          result = await probeEncoders({ ffmpegPath: ffmpeg.ffmpegPath, signal });
          break;
        case 'export':
          result = await runExportJob({
            ffmpegPath: ffmpeg.ffmpegPath,
            ffprobePath: ffmpeg.ffprobePath,
            root: job.root,
            doc: job.doc,
            options: job.options,
            hardwareEncoder: job.hardwareEncoder,
            output: job.output,
            overwrite: job.overwrite,
            signal,
            onProgress: progress,
            logger: this.logger,
          });
          break;
      }
      if (signal.aborted) throw new Error('cancelled');
      this.emit({
        type: 'job.done',
        jobId,
        kind: job.kind,
        result: JOB_RESULT_SCHEMAS[job.kind].parse(result),
      });
    } catch (error) {
      this.emit({
        type: 'job.error',
        jobId,
        message: error instanceof Error ? error.message : String(error),
        cancelled: signal.aborted,
      });
    } finally {
      this.jobs.delete(jobId);
    }
  }
}
