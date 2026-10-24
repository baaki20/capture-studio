/**
 * Turns `AudioContinuity` plans into encoder input (§1.5, §4.3.3). The file is one continuous
 * sample stream, so every piece written gets the file timestamp of its first frame:
 * `framesWrittenBefore / sampleRate`. The worker then builds one `AudioData` per segment (a copy
 * of a frame range of the incoming chunk, or digital silence).
 */
import type { AudioOp } from '../../../shared/recording/audio-continuity';
import type { Us } from '../../../shared/time';

export type AudioSegment =
  | { type: 'copy'; fromFrame: number; frames: number; fileFrame: number; timestampUs: Us }
  | { type: 'silence'; frames: number; fileFrame: number; timestampUs: Us; cause: 'gap' | 'pause' };

export function framesToUs(frames: number, sampleRate: number): Us {
  return Math.round((frames * 1_000_000) / sampleRate);
}

/** Lays out a plan's ops after `fileFrameStart` frames already written. */
export function layoutAudioOps(
  ops: readonly AudioOp[],
  fileFrameStart: number,
  sampleRate: number,
): AudioSegment[] {
  const segments: AudioSegment[] = [];
  let position = fileFrameStart;
  for (const op of ops) {
    const frames = op.type === 'copy' ? op.toFrame - op.fromFrame : op.frames;
    if (frames <= 0) continue;
    const timestampUs = framesToUs(position, sampleRate);
    segments.push(
      op.type === 'copy'
        ? { type: 'copy', fromFrame: op.fromFrame, frames, fileFrame: position, timestampUs }
        : { type: 'silence', frames, fileFrame: position, timestampUs, cause: op.cause },
    );
    position += frames;
  }
  return segments;
}

/**
 * Which source channel feeds output channel `outChannel` when the device's channel count differs
 * from the encoder's (mono → stereo duplicates; extra source channels are left out).
 */
export function sourceChannel(outChannel: number, sourceChannels: number): number {
  return Math.min(outChannel, Math.max(0, sourceChannels - 1));
}

/** Linear peak (0–1) of planar float samples. */
export function peakOf(planes: readonly Iterable<number>[]): number {
  let peak = 0;
  for (const plane of planes) {
    for (const sample of plane) {
      const v = Math.abs(sample);
      if (v > peak) peak = v;
    }
  }
  return peak;
}
