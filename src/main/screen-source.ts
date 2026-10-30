/**
 * The session manager's `selectScreen` (§9.1 path a, R1.8): picks the screen source with
 * `pickScreenSource` and classifies the result.
 *
 * On GNOME Wayland, Cancel in the ScreenCast portal does not produce an empty source list:
 * Chromium logs "ScreenCastPortal failed: 2" (the portal's "user cancelled" response) and
 * `desktopCapturer.getSources` rejects with "Failed to get sources." Chromium gives no way to
 * tell that rejection apart from a portal that could not open at all, so while the portal is in
 * use a rejection counts as `cancelled`: back to the panel, no folder and no error (R1.8). It is
 * logged, so a portal that never shows up is still visible in the log.
 */
import type { Logger } from '../shared/logger';
import { pickScreenSource, type GetSources, type PickScreenOptions } from './display-media';
import type { ScreenSource } from './recording/session-manager';

export interface SelectScreenOptions extends PickScreenOptions {
  /** The ScreenCast portal picks the source (Linux with the PipeWire capturer, §9.1). */
  portal: boolean;
}

/** True for the `desktopCapturer` rejection that a cancelled portal causes. */
export function isPortalCancellation(message: string): boolean {
  return /failed to get sources/i.test(message);
}

/**
 * Resolves with the chosen source, or null when the user cancelled. Throws for real failures
 * (the session manager turns them into a failed state with a notice).
 */
export async function selectScreenSource(
  getSources: GetSources,
  options: SelectScreenOptions,
  logger: Logger,
): Promise<ScreenSource | null> {
  const { portal, ...pickOptions } = options;
  const pick = await pickScreenSource(getSources, pickOptions);
  if (pick.status === 'cancelled') return null;
  if (pick.status === 'failed') {
    if (portal) {
      const text = `recording: the screen-sharing portal returned no source (${pick.message}); treated as cancelled`;
      if (isPortalCancellation(pick.message)) logger.info(text);
      else logger.warn(text);
      return null;
    }
    throw new Error(pick.message);
  }
  return {
    sourceId: pick.screen.sourceId,
    label: pick.source.name,
    maxWidth: pick.screen.maxWidth,
    maxHeight: pick.screen.maxHeight,
  };
}
