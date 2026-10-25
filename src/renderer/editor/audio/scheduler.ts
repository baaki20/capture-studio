/**
 * Preview audio (§1.7, §4.3.8): the master clock and the chunk scheduler.
 *
 * - **Clock.** Playback is anchored at `(timelineUs, contextTime, rate)`. The timeline time being
 *   heard is `timelineAt(anchor, audioCtx.getOutputTimestamp().contextTime)`; the video renders
 *   that time. The context keeps running while paused or muted, so a silent timeline still runs.
 * - **Chunks.** Each audio media is decoded into about 1 s `AudioBuffer`s (`ChunkAccumulator`
 *   merges the decoder's small buffers). For every audio segment of the render plan
 *   (`audioSegments`, the same plan the export uses), the chunks overlapping it are scheduled
 *   with an `AudioBufferSourceNode` (`playbackRate = rate / clockRatio`) into the track's
 *   `GainNode`, then a master gain. `planChunk` computes when, from which offset and for how
 *   long; it skips into a chunk that is already late.
 * - **Gains.** Mute and solo are gains (0 when inaudible), so toggling them is immediate.
 * - **Seek / edit.** Seeking stops every node and reschedules from the new time; an edit that
 *   changes the segments does the same at the current time, a gain-only edit just ramps gains.
 *
 * The maths (`timelineAt`, `contextTimeFor`, `planChunk`, `ChunkAccumulator`) is pure and
 * unit-tested; `AudioScheduler` does the Web Audio plumbing.
 */
import { audioSegments, type AudioSegment } from '../../../shared/project/render-plan';
import type { ProjectV1 } from '../../../shared/project/schema';
import {
  LOOKAHEAD_US,
  planChunk,
  scheduleSignature,
  segmentFileAt,
  segmentTimelineAt,
  timelineAt,
  trackGains,
  type AudioSource,
  type PcmChunk,
  type TransportAnchor,
} from './schedule-math';

export * from './schedule-math';

export interface AudioSchedulerOptions {
  openSource: (url: string) => Promise<AudioSource>;
  lookaheadUs?: number;
  /** Poll interval while waiting for the lookahead window, ms. */
  tickMs?: number;
}

interface PlayingNode {
  node: AudioBufferSourceNode;
  endsAt: number;
}

export class AudioScheduler {
  private readonly master: GainNode;
  private readonly trackGainNodes = new Map<string, GainNode>();
  private readonly sources = new Map<string, Promise<AudioSource>>();
  private readonly nodes = new Set<PlayingNode>();
  private doc: ProjectV1 | null = null;
  private mediaUrls: Record<string, string> = {};
  private signature = '';
  private anchor: TransportAnchor | null = null;
  private generation = 0;
  private readonly lookaheadUs: number;
  private readonly tickMs: number;
  /** Scheduling errors (decode failures), for the status line. */
  lastError: string | null = null;

  constructor(
    readonly context: AudioContext,
    private readonly options: AudioSchedulerOptions,
  ) {
    this.master = context.createGain();
    this.master.connect(context.destination);
    this.lookaheadUs = options.lookaheadUs ?? LOOKAHEAD_US;
    this.tickMs = options.tickMs ?? 200;
  }

  /** The timeline time being heard now, or null when stopped. */
  heardTimeUs(): number | null {
    if (!this.anchor) return null;
    const now = Math.max(outputContextTime(this.context), this.anchor.contextTime);
    return timelineAt(this.anchor, now);
  }

  get playing(): boolean {
    return this.anchor !== null;
  }

  /** Updates gains, and reschedules at the current time if the audio itself changed. */
  setDoc(doc: ProjectV1, mediaUrls: Record<string, string>): void {
    this.doc = doc;
    this.mediaUrls = mediaUrls;
    const gains = trackGains(doc);
    const now = this.context.currentTime;
    for (const [trackId, gain] of gains) {
      const node = this.gainNode(trackId);
      node.gain.cancelScheduledValues(now);
      node.gain.setTargetAtTime(gain, now, 0.01);
    }
    const signature = scheduleSignature(doc, mediaUrls);
    if (signature !== this.signature) {
      this.signature = signature;
      const heard = this.heardTimeUs();
      if (heard !== null && this.anchor) this.start(heard, this.anchor.rate);
    }
  }

  /**
   * Starts playback of timeline time `fromUs` after `delaySec` (to give the decoder a head
   * start) and returns the anchor. Rates ≤ 0 run the clock without audio (reverse shuttle).
   */
  start(fromUs: number, rate: number, delaySec = 0.12): TransportAnchor {
    this.stopNodes();
    const generation = ++this.generation;
    const anchor: TransportAnchor = {
      timelineUs: fromUs,
      contextTime: this.context.currentTime + delaySec,
      rate,
    };
    this.anchor = anchor;
    if (rate > 0 && this.doc) {
      const segments = audioSegments(this.doc, { includeInaudible: true }).filter(
        (s) => !s.offline && s.timelineEndUs > fromUs && this.mediaUrls[s.mediaId],
      );
      const byTrack = new Map<string, AudioSegment[]>();
      for (const s of segments) byTrack.set(s.trackId, [...(byTrack.get(s.trackId) ?? []), s]);
      for (const [trackId, list] of byTrack) {
        void this.feedTrack(trackId, list, anchor, generation);
      }
    }
    return anchor;
  }

  stop(): void {
    this.generation++;
    this.anchor = null;
    this.stopNodes();
  }

  dispose(): void {
    this.stop();
    for (const source of this.sources.values())
      void source.then(
        (s) => s.dispose(),
        () => undefined,
      );
    this.sources.clear();
    this.master.disconnect();
  }

  private gainNode(trackId: string): GainNode {
    let node = this.trackGainNodes.get(trackId);
    if (!node) {
      node = this.context.createGain();
      node.connect(this.master);
      this.trackGainNodes.set(trackId, node);
    }
    return node;
  }

  private source(url: string): Promise<AudioSource> {
    let source = this.sources.get(url);
    if (!source) {
      source = this.options.openSource(url);
      this.sources.set(url, source);
      source.catch(() => this.sources.delete(url));
    }
    return source;
  }

  private async feedTrack(
    trackId: string,
    segments: readonly AudioSegment[],
    anchor: TransportAnchor,
    generation: number,
  ): Promise<void> {
    const live = () => this.generation === generation;
    try {
      for (const segment of segments) {
        if (!live()) return;
        const url = this.mediaUrls[segment.mediaId];
        if (!url) continue;
        // Wait until the segment comes within the lookahead window.
        while (live() && segment.timelineStartUs > this.windowEndUs(anchor)) await this.sleep();
        if (!live()) return;
        const source = await this.source(url);
        const fromUs = Math.max(
          segment.fileStartSeconds * 1_000_000,
          segmentFileAt(segment, anchor.timelineUs),
        );
        for await (const chunk of source.chunks(fromUs, segment.fileEndSeconds * 1_000_000)) {
          if (!live()) return;
          this.schedule(trackId, segment, chunk, anchor);
          while (live() && segmentTimelineAt(segment, chunk.fileEndUs) > this.windowEndUs(anchor)) {
            await this.sleep();
          }
        }
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  private windowEndUs(anchor: TransportAnchor): number {
    return timelineAt(anchor, this.context.currentTime) + this.lookaheadUs;
  }

  private schedule(
    trackId: string,
    segment: AudioSegment,
    chunk: PcmChunk,
    anchor: TransportAnchor,
  ): void {
    const plan = planChunk(segment, chunk, anchor, this.context.currentTime);
    if (!plan) return;
    const buffer = this.context.createBuffer(
      chunk.channels.length,
      chunk.channels[0]?.length ?? 0,
      chunk.sampleRate,
    );
    chunk.channels.forEach((data, c) => buffer.copyToChannel(data, c));
    const node = this.context.createBufferSource();
    node.buffer = buffer;
    node.playbackRate.value = plan.playbackRate;
    node.connect(this.gainNode(trackId));
    const entry: PlayingNode = { node, endsAt: plan.when + plan.duration / plan.playbackRate };
    this.nodes.add(entry);
    node.onended = () => {
      this.nodes.delete(entry);
      node.disconnect();
    };
    node.start(plan.when, plan.offset, plan.duration);
  }

  private stopNodes(): void {
    for (const { node } of this.nodes) {
      try {
        node.stop();
      } catch {
        // Not started yet or already stopped.
      }
      node.disconnect();
    }
    this.nodes.clear();
  }

  private sleep(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.tickMs));
  }
}

/** The context time of the sample reaching the speakers now. */
export function outputContextTime(context: AudioContext): number {
  const stamp = context.getOutputTimestamp();
  if (typeof stamp.contextTime === 'number' && stamp.contextTime > 0) {
    // getOutputTimestamp is sampled at the last render quantum; advance it by the wall time since.
    const since =
      typeof stamp.performanceTime === 'number'
        ? (performance.now() - stamp.performanceTime) / 1000
        : 0;
    return stamp.contextTime + Math.max(0, since);
  }
  return Math.max(0, context.currentTime - (context.outputLatency || context.baseLatency || 0));
}
