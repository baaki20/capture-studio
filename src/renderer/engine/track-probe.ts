/**
 * Reads a freshly acquired track's real properties (§9.1, §9.3):
 * - video: the size of the first `VideoFrame` (`getSettings()` echoes the constraints instead),
 *   and the delivered frame rate over a short window (cameras may deliver far below the request);
 * - audio: the first chunk's sample rate and channel count.
 *
 * Probing reads a **clone** of the track, so the original's processor (created at start) begins
 * fresh; stopping the clone never ends the original.
 */
import { FrameRateMeter } from './encoder-select';
import { audioChunks, videoFrames } from './track-processor';

export const FIRST_SAMPLE_TIMEOUT_MS = 5_000;
export const RATE_WINDOW_MS = 1_000;

export interface VideoProbe {
  width: number;
  height: number;
  /** Delivered rate, or null when fewer than two frames arrived in the window. */
  deliveredFps: number | null;
  /** The last frame seen, when `keepStill` was asked for (the owner must `close()` it). */
  still?: ImageBitmap;
}

/** A still of a video track (region picker, §4.3.7), as PNG in the frame's own pixels. */
export interface Snapshot {
  width: number;
  height: number;
  png: Uint8Array;
}

export const SNAPSHOT_TIMEOUT_MS = 1_500;

export interface AudioProbe {
  sampleRate: number;
  channels: number;
}

/** Reads one sample, or null on timeout; a sample that arrives after the timeout is closed. */
async function readWithTimeout<T extends { close(): void }>(
  reader: ReadableStreamDefaultReader<T>,
  timeoutMs: number,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const state = { timedOut: false };
  const read = reader.read();
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      state.timedOut = true;
      resolve(null);
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([read, timeout]);
    if (result === null || result.done) return null;
    return result.value;
  } finally {
    clearTimeout(timer);
    if (state.timedOut) {
      void read.then(
        (late) => {
          if (!late.done) late.value.close();
        },
        () => undefined,
      );
    }
  }
}

export async function probeVideoTrack(
  track: MediaStreamTrack,
  rateWindowMs = RATE_WINDOW_MS,
  keepStill = false,
): Promise<VideoProbe> {
  const clone = track.clone();
  const reader = videoFrames(clone).getReader();
  let last: VideoFrame | null = null;
  try {
    const first = await readWithTimeout(reader, FIRST_SAMPLE_TIMEOUT_MS);
    if (!first) throw new Error(`no video frame within ${String(FIRST_SAMPLE_TIMEOUT_MS)} ms`);
    const meter = new FrameRateMeter();
    const probe = { width: first.displayWidth, height: first.displayHeight };
    meter.onFrame(first.timestamp);
    last = first;
    const end = performance.now() + rateWindowMs;
    while (performance.now() < end) {
      const frame = await readWithTimeout(reader, Math.max(1, end - performance.now()));
      if (!frame) break;
      meter.onFrame(frame.timestamp);
      last.close();
      last = frame;
    }
    // A screen that does not change may deliver no new frame later, so the picker keeps this one.
    const still = keepStill ? await createImageBitmap(last).catch(() => null) : null;
    return { ...probe, deliveredFps: meter.fps, ...(still ? { still } : {}) };
  } finally {
    last?.close();
    await reader.cancel().catch(() => undefined);
    clone.stop();
  }
}

export async function probeAudioTrack(track: MediaStreamTrack): Promise<AudioProbe> {
  const clone = track.clone();
  const reader = audioChunks(clone).getReader();
  try {
    const first = await readWithTimeout(reader, FIRST_SAMPLE_TIMEOUT_MS);
    if (!first) throw new Error(`no audio within ${String(FIRST_SAMPLE_TIMEOUT_MS)} ms`);
    const probe = { sampleRate: first.sampleRate, channels: first.numberOfChannels };
    first.close();
    return probe;
  } finally {
    await reader.cancel().catch(() => undefined);
    clone.stop();
  }
}

/**
 * The current frame of `track` as PNG. A fresh frame is read from a clone; when none arrives in
 * time (a static screen may send none), `fallback` (the still kept at acquisition) is used.
 */
export async function snapshotVideoTrack(
  track: MediaStreamTrack,
  fallback: ImageBitmap | null,
  timeoutMs = SNAPSHOT_TIMEOUT_MS,
): Promise<Snapshot> {
  const clone = track.clone();
  const reader = videoFrames(clone).getReader();
  let frame: VideoFrame | null = null;
  try {
    frame = track.readyState === 'live' ? await readWithTimeout(reader, timeoutMs) : null;
    const source: VideoFrame | ImageBitmap | null = frame ?? fallback;
    if (!source) throw new Error('no frame of the screen is available');
    const width = frame ? frame.displayWidth : (fallback?.width ?? 0);
    const height = frame ? frame.displayHeight : (fallback?.height ?? 0);
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no 2D canvas for the snapshot');
    context.drawImage(source, 0, 0, width, height);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return { width, height, png: new Uint8Array(await blob.arrayBuffer()) };
  } finally {
    frame?.close();
    await reader.cancel().catch(() => undefined);
    clone.stop();
  }
}
