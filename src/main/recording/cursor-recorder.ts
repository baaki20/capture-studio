/**
 * Records the cursor track of a screen recording (R3.7–R3.9, format v3 `cursor.jsonl`,
 * `shared/project/cursor-track.ts`): takes samples from a `CursorSource`, maps them onto the
 * session clock and into the screen video's pixels, and streams them to the file.
 *
 * - **Clock:** the session starts at the engine's `t0Us`, on main's wall-anchored performance
 *   clock (the engine shares it). A handshake at start (median of a few readings) gives the offset
 *   from the source's clock to main's, so `sessionUs = sourceUs + offset − t0Us`. File time is
 *   session time (the media's `startOffsetUs` is 0); samples before `t0` are dropped, and times
 *   never go backwards.
 * - **Pixels:** `video = (global − origin) × scale`, from the captured monitor's rect in the
 *   source's coordinate space and the captured frame size, less a record-time crop
 *   (`monitorMapping`). Positions outside the video are kept: the cursor may leave the area.
 * - Pauses are recorded like the other media: the timeline leaves the paused time out.
 */
import { createWriteStream } from 'node:fs';
import type { Logger } from '../../shared/logger';
import {
  cursorEventLine,
  cursorHeaderLine,
  type CursorEvent,
} from '../../shared/project/cursor-track';
import type { NRect } from '../../shared/project/schema';
import type { CursorSource, RawCursorSample } from './cursor-source';

/** Global → video pixels: `(g − origin) × scale`; `width` × `height` is the video size. */
export interface CursorMapping {
  originX: number;
  originY: number;
  scaleX: number;
  scaleY: number;
  width: number;
  height: number;
}

/**
 * The mapping for a monitor capture: `display` is the monitor's rect in the source's coordinate
 * space, `frame` the captured frame size, `crop` the region encoded at record time (frame pixels).
 */
export function monitorMapping(args: {
  display: { x: number; y: number; width: number; height: number };
  frame: { width: number; height: number };
  crop: NRect | null;
}): CursorMapping {
  const { display, frame, crop } = args;
  const scaleX = frame.width / display.width;
  const scaleY = frame.height / display.height;
  return {
    originX: display.x + (crop ? crop.x / scaleX : 0),
    originY: display.y + (crop ? crop.y / scaleY : 0),
    scaleX,
    scaleY,
    width: crop?.width ?? frame.width,
    height: crop?.height ?? frame.height,
  };
}

export interface CursorRecordingResult {
  samples: number;
  clicks: number;
  /** Session time of the last sample. */
  durationUs: number;
  sampleRateHz: number;
  /** Whether presses and releases were recorded at all (false for polling). */
  clicksAvailable: boolean;
  source: CursorSource['kind'];
}

export interface WritableLike {
  write(chunk: string): boolean;
  end(callback: () => void): void;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export interface CursorRecorderOptions {
  source: CursorSource;
  file: string;
  mapping: CursorMapping;
  /** Session zero on main's clock (the engine's `t0Us`). */
  t0Us: number;
  /** Main's clock in µs (wall-anchored performance clock). */
  mainNowUs: () => number;
  sampleRateHz: number;
  logger: Logger;
  open?: (file: string) => WritableLike;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/** Offset from the source's clock to main's: the median of a few back-to-back readings. */
export function clockOffsetUs(sourceNowUs: () => number, mainNowUs: () => number): number {
  const readings: number[] = [];
  for (let i = 0; i < 7; i++) {
    const before = sourceNowUs();
    const main = mainNowUs();
    const after = sourceNowUs();
    readings.push(main - (before + after) / 2);
  }
  readings.sort((a, b) => a - b);
  return readings[3] ?? 0;
}

export class CursorRecorder {
  /** Opened once the source has started, so a source that fails leaves no file behind. */
  private out: WritableLike | null = null;
  /** Lines from before the file was open (a source may deliver during `start`). */
  private pending = '';
  private offsetUs = 0;
  private lastUs = 0;
  private samples = 0;
  private clicks = 0;
  private clicksAvailable = false;
  private failed: Error | null = null;
  private started = false;

  constructor(private readonly options: CursorRecorderOptions) {}

  /** Starts the source, then opens the file; throws (writing nothing) when the source fails. */
  start(): { clicks: boolean } {
    const { mapping, source } = this.options;
    this.offsetUs = clockOffsetUs(() => source.nowUs(), this.options.mainNowUs);
    const started = source.start((batch) => this.onSamples(batch));
    this.clicksAvailable = started.clicks;
    this.started = true;
    const out = (this.options.open ?? ((file) => createWriteStream(file, { flags: 'w' })))(
      this.options.file,
    );
    out.on('error', (error: Error) => {
      this.failed ??= error;
    });
    const header = cursorHeaderLine({
      sampleRateHz: this.options.sampleRateHz,
      width: mapping.width,
      height: mapping.height,
    });
    out.write(`${header}\n${this.pending}`);
    this.pending = '';
    this.out = out;
    return started;
  }

  private onSamples(batch: readonly RawCursorSample[]): void {
    const { mapping, t0Us } = this.options;
    let text = '';
    for (const s of batch) {
      const sessionUs = Math.round(s.tUs + this.offsetUs - t0Us);
      if (sessionUs < 0) continue;
      const tUs = Math.max(this.lastUs, sessionUs);
      this.lastUs = tUs;
      const x = round1((s.x - mapping.originX) * mapping.scaleX);
      const y = round1((s.y - mapping.originY) * mapping.scaleY);
      const event: CursorEvent =
        s.action === 'move' || !s.button
          ? { tUs, x, y }
          : { tUs, x, y, action: s.action, button: s.button };
      if (s.action === 'down' && s.button) this.clicks += 1;
      this.samples += 1;
      text += `${cursorEventLine(event)}\n`;
    }
    if (!text) return;
    if (this.out) this.out.write(text);
    else this.pending += text;
  }

  /** Stops the source and closes the file; null when the file could not be written. */
  async stop(): Promise<CursorRecordingResult | null> {
    if (this.started) {
      await this.options.source.stop().catch((error: unknown) => {
        this.options.logger.warn('recording: stopping the cursor source failed', error);
      });
    }
    const out = this.out;
    if (out) {
      await new Promise<void>((resolve) => {
        out.end(resolve);
      });
    }
    if (!this.started) return null;
    if (this.failed) {
      this.options.logger.warn('recording: the cursor track could not be written', this.failed);
      return null;
    }
    return {
      samples: this.samples,
      clicks: this.clicks,
      durationUs: this.lastUs,
      sampleRateHz: this.options.sampleRateHz,
      clicksAvailable: this.clicksAvailable,
      source: this.options.source.kind,
    };
  }
}
