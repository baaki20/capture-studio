/**
 * Capability helpers shared by the Linux, Windows and macOS detectors (§1.4).
 */
import {
  available,
  unavailable,
  type Capability,
  type FfmpegEncoderReport,
} from '../../shared/capabilities/types';

export interface SecretsStatusLike {
  persistent: boolean;
  backend: string;
  reason: string | null;
}

export function ffmpegHardwareCapability(report: FfmpegEncoderReport | null): Capability {
  if (!report) return unavailable('Encoder probe has not finished; libx264 is used.', 'libx264');
  if (report.hardware) return available(report.hardware, 'Verified with a 1 s test encode.');
  const failed = report.encoders
    .filter((e) => e.kind !== 'software')
    .map((e) => `${e.name}: ${e.listed ? (e.error ?? 'failed') : 'not in this build'}`);
  return unavailable(
    `No working hardware encoder${failed.length ? ` (${failed.join('; ')})` : ''}. libx264 is used.`,
    'libx264',
  );
}

export function secretsCapability(status: SecretsStatusLike | null): Capability {
  if (!status) return unavailable('Secret storage has not been checked yet.');
  return status.persistent
    ? available(`safeStorage:${status.backend}`)
    : unavailable(
        status.reason ?? `Backend ${status.backend} does not encrypt; secrets stay in memory.`,
        `memory (backend ${status.backend})`,
      );
}

/** The engine measures WebCodecs hardware encoding when recording starts (an override). */
export const webcodecsPending: Capability = unavailable(
  'Probed by the capture engine when recording starts; software H.264 (WebCodecs) is used meanwhile.',
  'webcodecs-software',
);
