/**
 * Output latency of the PipeWire default sink, used to place system audio on the session clock.
 *
 * `pw-record` taps the sink's monitor when the graph processes a block, before the block is
 * written to the device and played. A video player (or any A/V app) shows its picture when the
 * sound is heard, so the monitor runs ahead of the screen by the sink's output latency. The
 * flash-and-beep sync test (tests/sync) measured 42 ms on the dev machine with a 1024-sample
 * quantum at 48 kHz: two quanta (one in the graph, one in the device buffer).
 *
 * PipeWire's Latency params report 0 for ALSA sinks, so the estimate is two quanta of the
 * current graph quantum (`clock.force-quantum`, else `clock.quantum`) at `clock.rate`.
 */
import type { ExecFn } from '../capabilities/detect';

export const QUANTA_OF_OUTPUT_LATENCY = 2;
const FALLBACK = { quantum: 1024, rate: 48_000 };

/** Parses `pw-metadata -n settings 0` output into the effective quantum and rate. */
export function parseClockSettings(stdout: string): { quantum: number; rate: number } {
  const value = (key: string): number | null => {
    const m = new RegExp(`key:'${key.replace(/\./g, '\\.')}'\\s+value:'(\\d+)'`).exec(stdout);
    return m?.[1] ? Number(m[1]) : null;
  };
  const forced = value('clock.force-quantum');
  const quantum =
    forced !== null && forced > 0 ? forced : (value('clock.quantum') ?? FALLBACK.quantum);
  const forcedRate = value('clock.force-rate');
  const rate =
    forcedRate !== null && forcedRate > 0 ? forcedRate : (value('clock.rate') ?? FALLBACK.rate);
  return { quantum, rate };
}

export function outputLatencyUs(settings: { quantum: number; rate: number }): number {
  return Math.round((QUANTA_OF_OUTPUT_LATENCY * settings.quantum * 1_000_000) / settings.rate);
}

/** Estimated output latency of the default sink in µs; falls back to 1024 @ 48 kHz. */
export async function estimateSinkOutputLatencyUs(exec: ExecFn): Promise<number> {
  const result = await exec('pw-metadata', ['-n', 'settings', '0'], { timeoutMs: 2000 });
  const settings =
    result.error === null && result.code === 0 ? parseClockSettings(result.stdout) : FALLBACK;
  return outputLatencyUs(settings);
}
