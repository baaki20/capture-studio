/**
 * Decoder pool of the preview (§4.3.8): one demuxer and **one `VideoDecoder` per video media**,
 * feeding the shared `FrameCache`.
 *
 * Per media (`MediaDecoder`):
 * - `request(t)` sets the target file time. A pump decodes from the key packet at or before the
 *   target and keeps about `aheadUs` (1.5 s) of packets fed beyond it, with at most `maxQueue`
 *   chunks queued in the decoder (backpressure).
 * - A *run* (`DecodeRun`) is one sequence of packets from a key packet. A target inside the run
 *   or a little ahead of it (`continueUs`) continues the run; anything else (backwards, a far
 *   jump, or a frame the cache has since evicted) resets the decoder and starts a new run.
 * - `frameFor(t)` answers the frame to show at t: the latest frame with timestamp ≤ t, `exact`
 *   once the decoder has output a later frame (or the file ended). Until then it offers the
 *   nearest cached frame as a stand-in.
 *
 * Every decoded frame goes to the cache, which closes it exactly once; frames that arrive for a
 * superseded run are closed at once. Platform objects are behind `DecoderBackend`, so the
 * bookkeeping is unit-tested with fakes.
 */
import type { CacheableFrame, FrameCache } from './frame-cache';

/** Default backpressure: decode-queue length above which the pump waits. */
export const MAX_DECODE_QUEUE = 8;
/** A target at most this far past the fed packets continues the run instead of seeking. */
export const CONTINUE_RUN_US = 2_500_000;

export interface DemuxedPacket {
  timestampUs: number;
  key: boolean;
  /** The packet as a WebCodecs chunk. */
  chunk(): EncodedVideoChunk;
}

/** One opened video file. */
export interface VideoDemuxer {
  readonly config: VideoDecoderConfig;
  /** The key packet at or before `tUs` (the first key packet when t is before it). */
  keyPacketAtOrBefore(tUs: number): Promise<DemuxedPacket | null>;
  /** Packets in decode order starting with `start`. */
  packetsFrom(start: DemuxedPacket): AsyncIterator<DemuxedPacket>;
  dispose(): void;
}

/** The parts of `VideoDecoder` the pool uses. */
export interface VideoDecoderLike {
  readonly decodeQueueSize: number;
  readonly state: 'unconfigured' | 'configured' | 'closed';
  configure(config: VideoDecoderConfig): void;
  decode(chunk: EncodedVideoChunk): void;
  flush(): Promise<void>;
  reset(): void;
  close(): void;
}

export interface DecoderBackend<F extends CacheableFrame> {
  openDemuxer(url: string): Promise<VideoDemuxer>;
  createDecoder(output: (frame: F) => void, error: (error: Error) => void): VideoDecoderLike;
  /** Waits a little for the decoder to drain (backpressure). */
  wait?: () => Promise<void>;
}

export interface FrameAnswer<F> {
  frame: F | null;
  /** True when `frame` is exactly the frame to show at the requested time. */
  exact: boolean;
}

/** Bookkeeping of one decode run (pure; exported for tests). */
export class DecodeRun {
  /** Highest packet timestamp fed to the decoder. */
  fedUpToUs = Number.NEGATIVE_INFINITY;
  /** Output frame timestamps, ascending (decoders output in presentation order). */
  readonly outputs: number[] = [];
  ended = false;

  constructor(readonly startUs: number) {}

  recordFed(timestampUs: number): void {
    this.fedUpToUs = Math.max(this.fedUpToUs, timestampUs);
  }

  recordOutput(timestampUs: number): void {
    const last = this.outputs[this.outputs.length - 1];
    if (last === undefined || timestampUs > last) this.outputs.push(timestampUs);
    else if (!this.outputs.includes(timestampUs)) {
      this.outputs.push(timestampUs);
      this.outputs.sort((a, b) => a - b);
    }
  }

  /** Whether the frame shown at `tUs` is known: decoded past t (or the file ended). */
  resolves(tUs: number): boolean {
    if (tUs < this.startUs) return false;
    const last = this.outputs[this.outputs.length - 1];
    return this.ended ? this.outputs.length > 0 : last !== undefined && last > tUs;
  }

  /** The timestamp of the frame shown at `tUs` according to this run, or null. */
  frameTimestampAt(tUs: number): number | null {
    let lo = 0;
    let hi = this.outputs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.outputs[mid] ?? Infinity) <= tUs) lo = mid + 1;
      else hi = mid;
    }
    return this.outputs[lo - 1] ?? null;
  }

  /** How to reach `tUs`: it is in the run, a little ahead (keep feeding), or needs a seek. */
  reach(tUs: number, continueUs = CONTINUE_RUN_US): 'inside' | 'ahead' | 'seek' {
    if (tUs < this.startUs) return 'seek';
    if (this.ended || tUs <= this.fedUpToUs) return 'inside';
    return tUs - Math.max(this.fedUpToUs, this.startUs) <= continueUs ? 'ahead' : 'seek';
  }
}

export interface MediaDecoderOptions {
  aheadUs?: number;
  maxQueue?: number;
  continueUs?: number;
}

const defaultWait = () => new Promise<void>((resolve) => setTimeout(resolve, 4));

export class MediaDecoder<F extends CacheableFrame> {
  private demuxer: VideoDemuxer | null = null;
  private opening: Promise<VideoDemuxer> | null = null;
  private decoder: VideoDecoderLike | null = null;
  private packets: AsyncIterator<DemuxedPacket> | null = null;
  private run: DecodeRun | null = null;
  private target: number | null = null;
  private forceSeek = false;
  private pumping = false;
  private disposed = false;
  /** Set when the file cannot be opened or decoded; no further work is attempted. */
  error: Error | null = null;
  readonly aheadUs: number;
  private readonly maxQueue: number;
  private readonly continueUs: number;

  constructor(
    readonly mediaId: string,
    private readonly url: string,
    private readonly backend: DecoderBackend<F>,
    private readonly cache: FrameCache<F>,
    private readonly onFrame: (mediaId: string) => void,
    private readonly onError: (mediaId: string, error: Error) => void,
    options: MediaDecoderOptions = {},
  ) {
    this.aheadUs = options.aheadUs ?? cache.aheadUs;
    this.maxQueue = options.maxQueue ?? MAX_DECODE_QUEUE;
    this.continueUs = options.continueUs ?? CONTINUE_RUN_US;
  }

  /** The current run (tests). */
  get currentRun(): DecodeRun | null {
    return this.run;
  }

  get busy(): boolean {
    return this.pumping;
  }

  /** Asks for the frame at file time `tUs` (and the frames after it). */
  request(tUs: number): void {
    if (this.disposed || this.error) return;
    this.target = Math.max(0, Math.round(tUs));
    this.cache.retainWindow(this.mediaId, this.target);
    void this.pump();
  }

  frameFor(tUs: number): FrameAnswer<F> {
    const run = this.run;
    if (run?.resolves(tUs)) {
      const expected = run.frameTimestampAt(tUs);
      const frame = this.cache.frameAt(this.mediaId, tUs);
      if (frame && frame.timestamp === expected) return { frame, exact: true };
      if (expected !== null && !this.pumping) {
        // The cache evicted the frame since; decode it again.
        this.forceSeek = true;
        this.request(tUs);
      }
    }
    return { frame: this.cache.nearest(this.mediaId, tUs), exact: false };
  }

  dispose(): void {
    this.disposed = true;
    this.target = null;
    void this.packets?.return?.();
    this.packets = null;
    try {
      if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    } catch {
      // Closing twice is harmless.
    }
    this.decoder = null;
    this.demuxer?.dispose();
    this.demuxer = null;
    this.cache.clearMedia(this.mediaId);
  }

  private async open(): Promise<VideoDemuxer> {
    if (this.demuxer) return this.demuxer;
    this.opening ??= this.backend.openDemuxer(this.url);
    const demuxer = await this.opening;
    if (this.disposed) {
      demuxer.dispose();
      throw new Error('disposed');
    }
    this.demuxer = demuxer;
    return demuxer;
  }

  private ensureDecoder(config: VideoDecoderConfig): VideoDecoderLike {
    if (this.decoder && this.decoder.state !== 'closed') return this.decoder;
    const decoder = this.backend.createDecoder(
      (frame) => this.output(frame),
      (error) => this.fail(error),
    );
    decoder.configure(config);
    this.decoder = decoder;
    return decoder;
  }

  private output(frame: F): void {
    const run = this.run;
    if (this.disposed || !run || frame.timestamp < run.startUs) {
      frame.close();
      return;
    }
    run.recordOutput(frame.timestamp);
    this.cache.put(this.mediaId, frame);
    this.onFrame(this.mediaId);
  }

  private fail(error: Error): void {
    if (this.disposed || this.error) return;
    this.error = error;
    this.onError(this.mediaId, error);
  }

  private async seek(demuxer: VideoDemuxer, tUs: number): Promise<void> {
    const key = await demuxer.keyPacketAtOrBefore(tUs);
    void this.packets?.return?.();
    this.packets = null;
    const decoder = this.ensureDecoder(demuxer.config);
    if (this.run) {
      decoder.reset();
      decoder.configure(demuxer.config);
    }
    this.forceSeek = false;
    if (!key) {
      this.run = new DecodeRun(0);
      this.run.ended = true;
      return;
    }
    this.run = new DecodeRun(key.timestampUs);
    this.packets = demuxer.packetsFrom(key);
  }

  /** Disposed or failed (a method, so checks after an await are not narrowed away). */
  private stopped(): boolean {
    return this.disposed || this.error !== null;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      const demuxer = await this.open();
      const wait = this.backend.wait ?? defaultWait;
      for (;;) {
        const target = this.target;
        if (target === null || this.stopped()) return;
        const reach =
          this.forceSeek || !this.run ? 'seek' : this.run.reach(target, this.continueUs);
        if (reach === 'seek') await this.seek(demuxer, target);
        const run = this.run;
        const decoder = this.decoder;
        if (!run || !decoder || this.stopped()) return;

        // Feed until `aheadUs` past the target, the end of the file, or a new target that
        // needs a seek.
        let retarget = false;
        while (!run.ended && run.fedUpToUs < (this.target ?? target) + this.aheadUs) {
          if (this.stopped()) return;
          const latest = this.target;
          if (
            latest !== null &&
            latest !== target &&
            (this.forceSeek || run.reach(latest, this.continueUs) === 'seek')
          ) {
            retarget = true;
            break;
          }
          if (decoder.decodeQueueSize >= this.maxQueue) {
            await wait();
            continue;
          }
          const packets = this.packets;
          if (!packets) break;
          const next = await packets.next();
          if (this.run !== run || this.stopped()) {
            retarget = true;
            break;
          }
          if (next.done) {
            if (decoder.state === 'configured') await decoder.flush();
            run.ended = true;
            this.onFrame(this.mediaId);
            break;
          }
          decoder.decode(next.value.chunk());
          run.recordFed(next.value.timestampUs);
        }
        if (!retarget && this.target === target && !this.forceSeek) return;
      }
    } catch (error) {
      if (!this.stopped()) this.fail(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.pumping = false;
    }
  }
}

export interface PoolSource {
  mediaId: string;
  url: string;
}

/** One `MediaDecoder` per video media, sharing one frame cache. */
export class DecoderPool<F extends CacheableFrame> {
  private readonly decoders = new Map<string, MediaDecoder<F>>();
  private readonly urls = new Map<string, string>();
  private readonly frameListeners = new Set<(mediaId: string) => void>();
  private readonly errorListeners = new Set<(mediaId: string, error: Error) => void>();

  constructor(
    private readonly backend: DecoderBackend<F>,
    readonly cache: FrameCache<F>,
    private readonly options: MediaDecoderOptions = {},
  ) {}

  get openMediaIds(): string[] {
    return [...this.decoders.keys()];
  }

  /** The decoder of a media (tests and stats). */
  decoder(mediaId: string): MediaDecoder<F> | null {
    return this.decoders.get(mediaId) ?? null;
  }

  /** Sets the media that may be decoded; decoders of removed (or re-pointed) media close. */
  setSources(sources: readonly PoolSource[]): void {
    const next = new Map(sources.map((s) => [s.mediaId, s.url]));
    for (const [id, decoder] of this.decoders) {
      if (next.get(id) !== this.urls.get(id)) {
        decoder.dispose();
        this.decoders.delete(id);
      }
    }
    this.urls.clear();
    for (const [id, url] of next) this.urls.set(id, url);
  }

  request(mediaId: string, fileTimeUs: number): void {
    this.get(mediaId)?.request(fileTimeUs);
  }

  frameFor(mediaId: string, fileTimeUs: number): FrameAnswer<F> {
    return this.get(mediaId)?.frameFor(fileTimeUs) ?? { frame: null, exact: false };
  }

  failed(mediaId: string): Error | null {
    return this.decoders.get(mediaId)?.error ?? null;
  }

  onFrame(listener: (mediaId: string) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onError(listener: (mediaId: string, error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  dispose(): void {
    for (const decoder of this.decoders.values()) decoder.dispose();
    this.decoders.clear();
    this.cache.clear();
  }

  private get(mediaId: string): MediaDecoder<F> | null {
    const existing = this.decoders.get(mediaId);
    if (existing) return existing;
    const url = this.urls.get(mediaId);
    if (!url) return null;
    const decoder = new MediaDecoder<F>(
      mediaId,
      url,
      this.backend,
      this.cache,
      (id) => {
        for (const l of this.frameListeners) l(id);
      },
      (id, error) => {
        for (const l of this.errorListeners) l(id, error);
      },
      this.options,
    );
    this.decoders.set(mediaId, decoder);
    return decoder;
  }
}
