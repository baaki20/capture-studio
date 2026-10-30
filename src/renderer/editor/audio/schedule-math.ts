/**
 * The pure maths of preview audio (§4.3.8), used by `scheduler.ts` and unit-tested: the master
 * clock (`timelineAt`, `contextTimeFor`), chunk planning with clock ratios and late starts
 * (`planChunk`), merging decoded pieces into ~1 s chunks (`ChunkAccumulator`), per-track gains
 * after mute and solo, and the signature that decides when an edit needs rescheduling.
 */
import {
  audioSegments,
  dbToLinear,
  isTrackAudible,
  type AudioSegment,
} from '../../../shared/project/render-plan';
import type { ProjectV1 } from '../../../shared/project/schema';

export const CHUNK_TARGET_US = 1_000_000;
/** How far ahead of the heard time chunks are scheduled. */
export const LOOKAHEAD_US = 2_000_000;
/** Chunks starting less than this before "now" are started at once with an offset. */
export const START_SLACK_S = 0.005;

export interface TransportAnchor {
  /** Timeline time at `contextTime`. */
  timelineUs: number;
  /** `AudioContext` time in seconds. */
  contextTime: number;
  /** Playback rate (1 normal, 2 shuttle); must be > 0 for audio. */
  rate: number;
}

/** Timeline µs heard at `contextTime` (the master clock). */
export function timelineAt(anchor: TransportAnchor, contextTime: number): number {
  return anchor.timelineUs + (contextTime - anchor.contextTime) * anchor.rate * 1_000_000;
}

/** Context time (s) at which timeline time `timelineUs` is heard. */
export function contextTimeFor(anchor: TransportAnchor, timelineUs: number): number {
  return anchor.contextTime + (timelineUs - anchor.timelineUs) / 1_000_000 / anchor.rate;
}

/** The parts of an `AudioSegment` the scheduler needs. */
export type ScheduledSegment = Pick<
  AudioSegment,
  'timelineStartUs' | 'timelineEndUs' | 'fileStartSeconds' | 'fileEndSeconds' | 'clockRatio'
>;

/** A decoded chunk's file-local extent. */
export interface ChunkSpan {
  fileStartUs: number;
  fileEndUs: number;
}

export interface ChunkPlan {
  /** `AudioBufferSourceNode.start(when, offset, duration)` arguments, in seconds. */
  when: number;
  offset: number;
  duration: number;
  playbackRate: number;
  /** Timeline time the chunk part starts at (for bookkeeping). */
  timelineStartUs: number;
}

/** Timeline µs of file time `fileUs` inside a segment. */
export function segmentTimelineAt(segment: ScheduledSegment, fileUs: number): number {
  return (
    segment.timelineStartUs + (fileUs - segment.fileStartSeconds * 1_000_000) * segment.clockRatio
  );
}

/** File µs (exact) of timeline time `tUs` inside a segment. */
export function segmentFileAt(segment: ScheduledSegment, tUs: number): number {
  return (
    segment.fileStartSeconds * 1_000_000 + (tUs - segment.timelineStartUs) / segment.clockRatio
  );
}

/**
 * How to play the part of `chunk` that lies inside `segment`, given the transport anchor and the
 * context's current time. Null when nothing of it remains to be played.
 */
export function planChunk(
  segment: ScheduledSegment,
  chunk: ChunkSpan,
  anchor: TransportAnchor,
  nowContext: number,
): ChunkPlan | null {
  if (anchor.rate <= 0) return null;
  const segFileStart = segment.fileStartSeconds * 1_000_000;
  const segFileEnd = segment.fileEndSeconds * 1_000_000;
  const fileStart = Math.max(chunk.fileStartUs, segFileStart);
  const fileEnd = Math.min(chunk.fileEndUs, segFileEnd);
  if (fileEnd <= fileStart) return null;
  const playbackRate = anchor.rate / segment.clockRatio;
  const timelineStartUs = segmentTimelineAt(segment, fileStart);
  let when = contextTimeFor(anchor, timelineStartUs);
  let offset = (fileStart - chunk.fileStartUs) / 1_000_000;
  let duration = (fileEnd - fileStart) / 1_000_000;
  if (when < nowContext - START_SLACK_S) {
    // Late: start now, skipping what should already have played.
    const skip = (nowContext - when) * playbackRate;
    offset += skip;
    duration -= skip;
    when = nowContext;
    if (duration <= 0.001) return null;
  }
  return { when, offset, duration, playbackRate, timelineStartUs };
}

/**
 * How late (s) the part of `chunk` from the anchor's start onwards would begin playing; 0 when on
 * time. Above 0 the listener hears a gap: the preview counts it as an audio underrun (§4.6.4).
 * The part before the anchor (a chunk that starts before the playhead) is skipped on purpose and
 * never counts.
 */
export function chunkLatenessS(
  segment: ScheduledSegment,
  chunk: ChunkSpan,
  anchor: TransportAnchor,
  nowContext: number,
): number {
  if (anchor.rate <= 0) return 0;
  const start = Math.max(
    chunk.fileStartUs,
    segment.fileStartSeconds * 1_000_000,
    segmentFileAt(segment, anchor.timelineUs),
  );
  const end = Math.min(chunk.fileEndUs, segment.fileEndSeconds * 1_000_000);
  if (end <= start) return 0;
  const when = contextTimeFor(anchor, segmentTimelineAt(segment, start));
  return Math.max(0, nowContext - START_SLACK_S - when);
}

export interface PcmPiece {
  /** File-local start, µs. */
  timestampUs: number;
  sampleRate: number;
  /** One array per channel, all the same length. */
  channels: Float32Array<ArrayBuffer>[];
}

export interface PcmChunk {
  fileStartUs: number;
  fileEndUs: number;
  sampleRate: number;
  channels: Float32Array<ArrayBuffer>[];
}

/**
 * Merges the decoder's small PCM pieces into chunks of about `targetUs`. A gap or a format
 * change ends the current chunk early, so every chunk is contiguous.
 */
export class ChunkAccumulator {
  private pieces: PcmPiece[] = [];
  private frames = 0;

  constructor(private readonly targetUs = CHUNK_TARGET_US) {}

  /** Adds a piece; returns a finished chunk when one is complete. */
  push(piece: PcmPiece): PcmChunk[] {
    const out: PcmChunk[] = [];
    const last = this.pieces[this.pieces.length - 1];
    if (last) {
      const lastEnd =
        last.timestampUs + ((last.channels[0]?.length ?? 0) / last.sampleRate) * 1_000_000;
      const gapUs = Math.abs(piece.timestampUs - lastEnd);
      const tolerance = (2 / piece.sampleRate) * 1_000_000;
      if (
        gapUs > tolerance ||
        last.sampleRate !== piece.sampleRate ||
        last.channels.length !== piece.channels.length
      ) {
        const flushed = this.flush();
        if (flushed) out.push(flushed);
      }
    }
    this.pieces.push(piece);
    this.frames += piece.channels[0]?.length ?? 0;
    const first = this.pieces[0];
    if (first && (this.frames / first.sampleRate) * 1_000_000 >= this.targetUs) {
      const flushed = this.flush();
      if (flushed) out.push(flushed);
    }
    return out;
  }

  /** The partial chunk (end of stream), or null. */
  flush(): PcmChunk | null {
    const first = this.pieces[0];
    if (!first || this.frames === 0) {
      this.pieces = [];
      this.frames = 0;
      return null;
    }
    const channels = first.channels.map(() => new Float32Array(this.frames));
    let at = 0;
    for (const piece of this.pieces) {
      piece.channels.forEach((data, c) => channels[c]?.set(data, at));
      at += piece.channels[0]?.length ?? 0;
    }
    const chunk: PcmChunk = {
      fileStartUs: first.timestampUs,
      fileEndUs: first.timestampUs + (this.frames / first.sampleRate) * 1_000_000,
      sampleRate: first.sampleRate,
      channels,
    };
    this.pieces = [];
    this.frames = 0;
    return chunk;
  }
}

/** Gain per audio track after mute and solo (0 when inaudible), as the render plan has it. */
export function trackGains(doc: ProjectV1): Map<string, number> {
  const gains = new Map<string, number>();
  for (const track of doc.timeline.tracks) {
    if (track.type !== 'audio') continue;
    gains.set(track.id, isTrackAudible(doc, track) ? dbToLinear(track.gainDb) : 0);
  }
  return gains;
}

/** A key that changes when the scheduled audio would change (not for gain-only edits). */
export function scheduleSignature(doc: ProjectV1, mediaUrls: Record<string, string>): string {
  return JSON.stringify(
    audioSegments(doc, { includeInaudible: true }).map((s) => [
      s.trackId,
      s.mediaId,
      s.timelineStartUs,
      s.timelineEndUs,
      s.fileStartUs,
      s.fileEndUs,
      s.clockRatio,
      s.offline,
      mediaUrls[s.mediaId] ?? null,
    ]),
  );
}

/** Decoded audio of one media file, as PCM chunks from a file time. */
export interface AudioSource {
  chunks(fromFileUs: number, toFileUs: number): AsyncIterable<PcmChunk>;
  dispose(): void;
}
