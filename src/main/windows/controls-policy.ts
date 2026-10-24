/**
 * When the recording controls window is shown, hidden or minimized (R1.11, R1.12). Kept free of
 * Electron so it can be unit-tested.
 *
 * - Shown while acquiring, counting down, recording, paused and finalizing; hidden otherwise
 *   (including while the fullscreen region picker is open).
 * - When recording starts (countdown → recording) it is minimized if `minimizeOnStart`, so it
 *   stays out of the capture where content protection is unavailable (Linux, §1.4
 *   `ui.excludeFromCapture`). Pause and resume leave it as it is.
 */
import type { Settings } from '../../shared/settings/schema';
import type { RecordingState } from '../recording/state-machine';

export type ControlsWindowAction = 'show' | 'hide' | 'minimize' | 'none';

const SHOWN: readonly RecordingState[] = [
  'acquiring',
  'countdown',
  'recording',
  'paused',
  'finalizing',
];

/** R1.11: `auto` minimizes when the window cannot be excluded from the capture. */
export function shouldMinimizeOnStart(
  setting: Settings['recorder']['minimizeControlsOnStart'],
  excludeFromCaptureAvailable: boolean,
): boolean {
  if (setting === 'auto') return !excludeFromCaptureAvailable;
  return setting === 'on';
}

export function controlsWindowAction(
  previous: RecordingState | null,
  next: RecordingState,
  minimizeOnStart: boolean,
): ControlsWindowAction {
  if (!SHOWN.includes(next)) return 'hide';
  if (next === 'recording' && previous === 'countdown')
    return minimizeOnStart ? 'minimize' : 'show';
  // Pause and resume keep whatever the user (or the start) left.
  if (
    (next === 'recording' || next === 'paused') &&
    (previous === 'recording' || previous === 'paused')
  )
    return 'none';
  if (previous === next) return 'none';
  return 'show';
}
