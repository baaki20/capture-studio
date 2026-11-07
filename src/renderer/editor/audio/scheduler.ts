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
 * - **Envelopes.** Each track's gain envelope (`audio-gain.ts`: clip gain, fades, volume
 *   keyframes, ducking; the same one the export applies) is gain automation on a node before the
 *   track's gain, scheduled from the transport anchor on every start.
 * - **Speed.** A sped-up segment plays a preview render of its range at that speed with its pitch
 *   kept (`playableSegments`, rendered by the media utility with the export's `atempo`); it is
 *   silent until the render is ready.
 * - **Seek / edit.** Seeking stops every node and reschedules from the new time; an edit that
 *   changes the segments does the same at the current time, a gain-only edit just ramps gains.
 *
 * The maths (`timelineAt`, `contextTimeFor`, `planChunk`, `ChunkAccumulator`) is pure and
 * unit-tested; `AudioScheduler` does the Web Audio plumbing.
 */
import {
  gainAt,
  trackEnvelope,
  type GainPoint,
  type PeaksOf,
} from '../../../shared/project/audio-gain';
import { noiseByTrack } from '../../../shared/project/audio-cleanup';
import { audioSegments, type AudioSegment } from '../../../shared/project/render-plan';
import type { Project } from '../../../shared/project/schema';
import {
  chunkLatenessS,
  LOOKAHEAD_US,
  contextTimeFor,
  planChunk,
  playableSegments,
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
  /** Waveform peaks of loaded media, for ducking envelopes (none when absent). */
  peaksOf?: PeaksOf;
  lookaheadUs?: number;
  /** Poll interval while waiting for the lookahead window, ms. */
  tickMs?: number;
}

/** Instrumentation for the preview performance test (§4.6.4): audible gaps while playing. */
export interface AudioCounters {
  /** Chunks scheduled while playing. */
  chunks: number;
  /** Chunks that started late (a gap was heard). */
  underruns: number;
  /** Total lateness of those chunks, seconds. */
  underrunSeconds: number;
}

interface PlayingNode {
  node: AudioBufferSourceNode;
  endsAt: number;
}

/** Automation events scheduled per track on a start (a long ducked recording has thousands). */
const MAX_ENVELOPE_EVENTS = 20_000;

export class AudioScheduler {
  private readonly master: GainNode;
  private readonly trackGainNodes = new Map<string, GainNode>();
  /** Per track, the gain envelope (clip gain, fades, volume keyframes, ducking) before its gain. */
  private readonly envelopeNodes = new Map<string, GainNode>();
  private envelopes = new Map<string, GainPoint[] | null>();
  private envelopeSignature = '';
  private readonly sources = new Map<string, Promise<AudioSource>>();
  private readonly nodes = new Set<PlayingNode>();
  private doc: Project | null = null;
  private mediaUrls: Record<string, string> = {};
  /** Ready preview renders of sped-up segments: key → URL (`AudioRenders`). */
  private renders: ReadonlyMap<string, string> = new Map();
  private signature = '';
  /** URLs of what `start` scheduled: media and renders by segment media ID. */
  private playUrls: Record<string, string> = {};
  private anchor: TransportAnchor | null = null;
  private generation = 0;
  private readonly lookaheadUs: number;
  private readonly tickMs: number;
  /** Scheduling errors (decode failures), for the status line. */
  lastError: string | null = null;
  private counterValues: AudioCounters = { chunks: 0, underruns: 0, underrunSeconds: 0 };

  constructor(
    readonly context: AudioContext,
    private readonly options: AudioSchedulerOptions,
  ) {
    this.master = context.createGain();
    this.master.connect(context.destination);
    this.lookaheadUs = options.lookaheadUs ?? LOOKAHEAD_US;
    this.tickMs = options.tickMs ?? 200;
  }

  /** Underrun counters since the last reset (tests, diagnostics). */
  counters(): AudioCounters {
    return { ...this.counterValues };
  }

  resetCounters(): void {
    this.counterValues = { chunks: 0, underruns: 0, underrunSeconds: 0 };
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
  setDoc(doc: Project, mediaUrls: Record<string, string>): void {
    this.doc = doc;
    this.mediaUrls = mediaUrls;
    const gains = trackGains(doc);
    const now = this.context.currentTime;
    for (const [trackId, gain] of gains) {
      const node = this.gainNode(trackId);
      node.gain.cancelScheduledValues(now);
      node.gain.setTargetAtTime(gain, now, 0.01);
    }
    this.reschedule();
    this.refreshEnvelopes();
  }

  /**
   * Recomputes the tracks' gain envelopes (an edit, or waveform peaks that ducking needs have
   * loaded) and, while playing, schedules them again from the time being heard.
   */
  refreshEnvelopes(): void {
    if (!this.doc) return;
    const doc = this.doc;
    const next = new Map<string, GainPoint[] | null>();
    for (const track of doc.timeline.tracks) {
      if (track.type === 'audio') {
        next.set(track.id, trackEnvelope(doc, track.id, this.options.peaksOf));
      }
    }
    const signature = JSON.stringify([...next]);
    if (signature === this.envelopeSignature) return;
    this.envelopeSignature = signature;
    this.envelopes = next;
    const heard = this.heardTimeUs();
    if (heard !== null && this.anchor) this.applyEnvelopes(heard, this.anchor);
    else this.applyEnvelopes(0, null);
  }

  /**
   * Sets every envelope node to its level at `fromUs` and, with an anchor (playing), ramps it
   * through the envelope's breakpoints at their context times.
   */
  private applyEnvelopes(fromUs: number, anchor: TransportAnchor | null): void {
    const now = this.context.currentTime;
    for (const [trackId, points] of this.envelopes) {
      const gain = this.envelopeNode(trackId).gain;
      gain.cancelScheduledValues(0);
      if (!points) {
        gain.setValueAtTime(1, now);
        continue;
      }
      const start = anchor ? Math.max(now, contextTimeFor(anchor, fromUs)) : now;
      gain.setValueAtTime(gainAt(points, fromUs), start);
      if (!anchor || anchor.rate <= 0) continue;
      let count = 0;
      for (const p of points) {
        if (p.tUs <= fromUs) continue;
        gain.linearRampToValueAtTime(p.gain, contextTimeFor(anchor, p.tUs));
        if (++count >= MAX_ENVELOPE_EVENTS) break;
      }
    }
  }

  /** New ready renders of sped-up segments: they play from now on. */
  setRenders(renders: ReadonlyMap<string, string>): void {
    this.renders = renders;
    this.reschedule();
  }

  /** Reschedules at the current time when what plays changed. */
  private reschedule(): void {
    if (!this.doc) return;
    const signature = scheduleSignature(this.doc, this.mediaUrls, this.renders);
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
    this.applyEnvelopes(fromUs, anchor);
    if (rate > 0 && this.doc) {
      const playable = playableSegments(
        audioSegments(this.doc, { includeInaudible: true }),
        this.mediaUrls,
        this.renders,
        noiseByTrack(this.doc),
      );
      this.playUrls = playable.urls;
      const segments = playable.segments.filter(
        (s) => !s.offline && s.timelineEndUs > fromUs && playable.urls[s.mediaId],
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

  /** Where a track's sources connect: its envelope, then its gain. */
  private envelopeNode(trackId: string): GainNode {
    let node = this.envelopeNodes.get(trackId);
    if (!node) {
      node = this.context.createGain();
      node.connect(this.gainNode(trackId));
      this.envelopeNodes.set(trackId, node);
    }
    return node;
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
        const url = this.playUrls[segment.mediaId];
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
    const now = this.context.currentTime;
    const late = chunkLatenessS(segment, chunk, anchor, now);
    this.counterValues.chunks += 1;
    if (late > 0) {
      this.counterValues.underruns += 1;
      this.counterValues.underrunSeconds += late;
    }
    const plan = planChunk(segment, chunk, anchor, now);
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
    node.connect(this.envelopeNode(trackId));
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
