/**
 * The shared session clock (§1.5): `performance.timeOrigin + performance.now()` in µs. The engine
 * window and its workers share one process, so every context reads the same monotonic source;
 * the media utility uses the same formula and is aligned by a handshake (`clock-handshake.ts`).
 */
import type { Us } from '../../../shared/time';

export function sessionNowUs(): Us {
  return Math.round((performance.timeOrigin + performance.now()) * 1000);
}
