/**
 * Screen-source picking, path (a) from spike S1 (§9.1): main calls
 * `desktopCapturer.getSources({types: ['screen']})`, which on GNOME Wayland shows the ScreenCast
 * portal (on every recording in Phase 1). The engine then opens the chosen source with
 * `getUserMedia({chromeMediaSourceId})` (`engine.acquire`). Path (a) needs no user activation in
 * the page, so it works from the hidden engine window.
 *
 * - An empty list means the user cancelled the portal (R1.8): a clean `cancelled`, no error.
 * - On X11 (no portal) every monitor is listed; Phase 1 has no in-app source picker yet, so the
 *   preferred id (if given and present) or the first source is used.
 * - `maxWidth`/`maxHeight` are always set, because Chromium otherwise caps desktop capture at
 *   1920 × 1080. The engine reads the true size from the first frame and encodes at most 1440p.
 *
 * Requires the `WebRTCPipeWireCapturer` feature on Linux Wayland (set in `main/index.ts`).
 */
import type { EngineCommandPayload } from '../shared/ipc/contract';

/** Capture cap passed to Chromium (§9.1); the encoder scales larger sources down to 1440p (§8). */
export const SCREEN_CAPTURE_MAX = { width: 3840, height: 2160 } as const;

export interface DesktopSourceLike {
  id: string;
  name: string;
}

export type GetSources = (options: {
  types: 'screen'[];
  thumbnailSize: { width: number; height: number };
  fetchWindowIcons: boolean;
}) => Promise<DesktopSourceLike[]>;

export type ScreenPick =
  | {
      status: 'selected';
      source: DesktopSourceLike;
      /** Ready to pass as `engine.acquire`'s `screen`. */
      screen: EngineCommandPayload<'engine.acquire'>['screen'];
    }
  | { status: 'cancelled' }
  | { status: 'failed'; message: string };

export interface PickScreenOptions {
  fps: 30 | 60;
  /** X11 only: keep the user's previous monitor when it is still listed. */
  preferredSourceId?: string;
}

export async function pickScreenSource(
  getSources: GetSources,
  options: PickScreenOptions,
): Promise<ScreenPick> {
  let sources: DesktopSourceLike[];
  try {
    sources = await getSources({
      types: ['screen'],
      // No thumbnails: they cost a capture per monitor and the portal shows its own preview.
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false,
    });
  } catch (error) {
    return { status: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
  const source = sources.find((s) => s.id === options.preferredSourceId) ?? sources[0];
  if (!source) return { status: 'cancelled' };
  return {
    status: 'selected',
    source: { id: source.id, name: source.name },
    screen: {
      sourceId: source.id,
      maxWidth: SCREEN_CAPTURE_MAX.width,
      maxHeight: SCREEN_CAPTURE_MAX.height,
      fps: options.fps,
    },
  };
}

/** The Chromium feature switch the portal capturer needs on Linux (spike S1 ran with it). */
export const PIPEWIRE_CAPTURER_FEATURE = 'WebRTCPipeWireCapturer';
