/**
 * `getUserMedia` constraints for track acquisition (§4.3.2, §9.1).
 *
 * - **Screen** (path (a)): the `desktopCapturer` source id from main via Chromium's legacy
 *   `mandatory` constraints. `maxWidth`/`maxHeight` are always passed, because Chromium otherwise
 *   caps desktop capture at 1920 × 1080; the real size is read from the first frame.
 * - **Camera:** by deviceId, 1280 × 720 at 30 fps ideal (cameras may deliver less, §9.3).
 * - **Mic:** by deviceId, processing toggles from the setup panel (R1.5), mono ideal.
 *
 * Plain objects (no DOM types) so they can be unit-tested; they are structurally valid
 * `MediaStreamConstraints`.
 */
import type { EngineCommandPayload } from '../../../shared/ipc/contract';

type AcquirePayload = EngineCommandPayload<'engine.acquire'>;

export const CAMERA_IDEAL = { width: 1280, height: 720, frameRate: 30 } as const;

export interface DesktopVideoConstraints {
  audio: false;
  video: {
    mandatory: {
      chromeMediaSource: 'desktop';
      chromeMediaSourceId: string;
      maxWidth: number;
      maxHeight: number;
      maxFrameRate: number;
    };
  };
}

export function screenConstraints(screen: AcquirePayload['screen']): DesktopVideoConstraints {
  return {
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: screen.sourceId,
        maxWidth: screen.maxWidth,
        maxHeight: screen.maxHeight,
        maxFrameRate: screen.fps,
      },
    },
  };
}

export function cameraConstraints(camera: NonNullable<AcquirePayload['camera']>) {
  return {
    audio: false,
    video: {
      deviceId: { exact: camera.deviceId },
      width: { ideal: CAMERA_IDEAL.width },
      height: { ideal: CAMERA_IDEAL.height },
      frameRate: { ideal: CAMERA_IDEAL.frameRate },
    },
  } as const;
}

export function micConstraints(mic: NonNullable<AcquirePayload['mic']>) {
  return {
    video: false,
    audio: {
      deviceId: { exact: mic.deviceId },
      echoCancellation: mic.echoCancellation,
      noiseSuppression: mic.noiseSuppression,
      autoGainControl: mic.autoGainControl,
      channelCount: { ideal: 1 },
    },
  } as const;
}

/** `track.contentHint` per stream (§4.3.2). */
export const CONTENT_HINTS = { screen: 'detail', camera: 'motion', mic: 'speech' } as const;

/**
 * Error names `getUserMedia` uses when the user (or the portal) refused the screen. With path (a)
 * the portal normally runs in main's `desktopCapturer.getSources` (an empty list is the cancel),
 * but a portal that asks again at `getUserMedia` reports a cancel with these.
 */
const CANCEL_ERRORS = new Set(['NotAllowedError', 'AbortError']);

export function isCancelError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    typeof error.name === 'string' &&
    CANCEL_ERRORS.has(error.name)
  );
}

export function describeError(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'name' in error && 'message' in error) {
    return `${String(error.name)}: ${String(error.message)}`;
  }
  return String(error);
}
