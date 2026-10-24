/**
 * Engine ↔ media utility clock handshake (§9.5 risk). The engine pings the utility over the clock
 * port that main wired (`attachClock`); each `clock.pong` carries the utility's clock. The
 * NTP-style estimate from the shortest round trip (`estimateClockOffset`) gives
 * `offsetUs = utility − engine`.
 *
 * The session manager uses it to place pw-record system audio (timestamped in the utility) on the
 * engine's session clock (`externalClockOffsetUs = −offsetUs`) and to convert pause times.
 */
import type { EngineClock } from '../../../shared/ipc/contract';
import {
  estimateClockOffset,
  type ClockSample,
  type StreamPortMessage,
  type StreamPortReply,
} from '../../../shared/ipc/media-utility';
import type { StreamPortLike } from './port-sink';

export const CLOCK_PINGS = 8;
export const CLOCK_PING_TIMEOUT_MS = 500;

export interface HandshakeOptions {
  pings?: number;
  timeoutMs?: number;
  nowUs: () => number;
}

/** Pings sequentially (one in flight) and resolves with the estimate, or null if none answered. */
export async function measureClockOffset(
  port: StreamPortLike,
  options: HandshakeOptions,
): Promise<EngineClock | null> {
  const pings = options.pings ?? CLOCK_PINGS;
  const timeoutMs = options.timeoutMs ?? CLOCK_PING_TIMEOUT_MS;
  const samples: ClockSample[] = [];
  port.start();
  for (let id = 1; id <= pings; id += 1) {
    const sample = await new Promise<ClockSample | null>((resolve) => {
      const listener = (event: { data: unknown }): void => {
        const reply = event.data as StreamPortReply | null;
        if (reply?.type !== 'clock.pong' || reply.id !== id) return;
        done({ sentUs: reply.sentUs, remoteUs: reply.utilityUs, receivedUs: options.nowUs() });
      };
      const done = (value: ClockSample | null): void => {
        clearTimeout(timer);
        port.removeEventListener('message', listener);
        resolve(value);
      };
      const timer = setTimeout(() => done(null), timeoutMs);
      port.addEventListener('message', listener);
      port.postMessage(
        { type: 'clock.ping', id, sentUs: options.nowUs() } satisfies StreamPortMessage,
        [],
      );
    });
    if (sample) samples.push(sample);
  }
  const estimate = estimateClockOffset(samples);
  if (!estimate) return null;
  return {
    offsetUs: estimate.offsetUs,
    externalClockOffsetUs: -estimate.offsetUs,
    rttUs: estimate.rttUs,
    samples: samples.length,
  };
}
