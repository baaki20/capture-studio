/**
 * Resolves the engine's tracks with the sync calibrator (§1.5, hybrid mode per §9.2): video
 * tracks may share the screen's capture time domain, every audio track is arrival-calibrated.
 *
 * Workers collect warm-up samples with `CalibrationWindow`: `(arrivalUs, timestampUs)` for video
 * frames and `(arrivalUs, timestampUs + durationUs)` for audio chunks (arrival is measured
 * against the chunk's end). A track without any sample (nothing arrived) is left out and gets no
 * sync entry.
 */
import type { StreamKind } from '../../../shared/ipc/contract';
import type { EngineStreamResult } from '../../../shared/ipc/contract';
import {
  calibrate,
  type CalibrationPolicy,
  type CalibrationResult,
  type CalibrationSample,
} from '../../../shared/recording/sync-calibrator';

export interface TrackSamples {
  streamId: string;
  kind: StreamKind;
  samples: readonly CalibrationSample[];
}

export type StreamSync = NonNullable<EngineStreamResult['sync']>;

export interface ResolvedCalibration {
  /** Null when no track had samples. */
  result: CalibrationResult | null;
  byStream: Map<string, StreamSync>;
  /** Why the calibrator refused, if it did. */
  error: string | null;
}

export function trackKind(kind: StreamKind): 'video' | 'audio' {
  return kind === 'screen' || kind === 'camera' ? 'video' : 'audio';
}

export function resolveCalibration(
  tracks: readonly TrackSamples[],
  policy: CalibrationPolicy = 'hybrid',
): ResolvedCalibration {
  const usable = tracks.filter((t) => t.samples.length > 0);
  const byStream = new Map<string, StreamSync>();
  if (usable.length === 0) return { result: null, byStream, error: null };

  const calibrated = calibrate(
    usable.map((t) => ({
      id: t.streamId,
      kind: trackKind(t.kind),
      reference: t.kind === 'screen',
      samples: t.samples,
    })),
    { policy },
  );
  if (!calibrated.ok) {
    const e = calibrated.error;
    return { result: null, byStream, error: 'trackId' in e ? `${e.code}: ${e.trackId}` : e.code };
  }
  for (const track of calibrated.value.tracks) {
    byStream.set(track.id, {
      mode: track.mode,
      offsetUs: Math.round(track.offsetUs),
      clockHandshakeUs: track.clockHandshakeUs === null ? null : Math.round(track.clockHandshakeUs),
      reason: track.reason,
      stats: track.stats,
    });
  }
  return { result: calibrated.value, byStream, error: null };
}
