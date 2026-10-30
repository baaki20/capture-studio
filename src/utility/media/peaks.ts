/**
 * Waveform peaks (§4.3.5): FFmpeg decodes the first audio stream to mono s16le at 8 kHz, and
 * every 10 ms window (80 samples) becomes one `[min, max]` pair of little-endian Int16 values in
 * `cache/<mediaId>.peaks`. The file has no header: pair `i` covers `[i × 10 ms, (i+1) × 10 ms)`.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnChild } from './child-processes';

export const PEAKS_SAMPLE_RATE = 8000;
export const PEAKS_WINDOW_SAMPLES = 80;

/** Folds s16le samples into [min, max] pairs, keeping a partial window between chunks. */
export class PeakAccumulator {
  private readonly pairs: number[] = [];
  private min = 0;
  private max = 0;
  private count = 0;
  private odd: number | null = null;

  push(chunk: Uint8Array): void {
    let offset = 0;
    if (this.odd !== null && chunk.length > 0) {
      this.add(((chunk[0] ?? 0) << 8) | this.odd);
      this.odd = null;
      offset = 1;
    }
    const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    for (; offset + 1 < chunk.length; offset += 2) this.add(view.getInt16(offset, true));
    if (offset < chunk.length) this.odd = chunk[offset] ?? null;
  }

  private add(raw: number): void {
    const sample = raw > 0x7fff ? raw - 0x10000 : raw;
    if (this.count === 0) {
      this.min = sample;
      this.max = sample;
    } else {
      if (sample < this.min) this.min = sample;
      if (sample > this.max) this.max = sample;
    }
    this.count += 1;
    if (this.count === PEAKS_WINDOW_SAMPLES) this.flushWindow();
  }

  private flushWindow(): void {
    if (this.count === 0) return;
    this.pairs.push(this.min, this.max);
    this.count = 0;
  }

  /** Ends the stream (a trailing partial window still yields a pair) and returns the bytes. */
  finish(): Buffer {
    this.flushWindow();
    const out = Buffer.alloc(this.pairs.length * 2);
    this.pairs.forEach((value, i) => out.writeInt16LE(value, i * 2));
    return out;
  }
}

export interface PeaksOptions {
  ffmpegPath: string;
  input: string;
  output: string;
  signal?: AbortSignal;
}

export async function generatePeaks(
  options: PeaksOptions,
): Promise<{ output: string; pairs: number; sampleRate: 8000; windowSamples: 80 }> {
  const accumulator = new PeakAccumulator();
  await new Promise<void>((resolve, reject) => {
    const child = spawnChild(
      options.ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-i',
        options.input,
        '-map',
        '0:a:0',
        '-ac',
        '1',
        '-ar',
        String(PEAKS_SAMPLE_RATE),
        '-f',
        's16le',
        '-',
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => accumulator.push(chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8192);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`peaks: ffmpeg exited with ${String(code)}: ${stderr.trim()}`));
    });
  });

  const bytes = accumulator.finish();
  await fs.mkdir(path.dirname(options.output), { recursive: true });
  const tmp = `${options.output}.tmp`;
  await fs.writeFile(tmp, bytes);
  await fs.rename(tmp, options.output);
  return {
    output: options.output,
    pairs: bytes.length / 4,
    sampleRate: PEAKS_SAMPLE_RATE,
    windowSamples: PEAKS_WINDOW_SAMPLES,
  };
}
