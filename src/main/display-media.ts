/**
 * Screen-source picking, path (a) from spike S1 (§9.1): main calls
 * `desktopCapturer.getSources({types: ['screen']})`, which on GNOME Wayland shows the ScreenCast
 * portal (on every recording in Phase 1). The engine then opens the chosen source with
 * `getUserMedia({chromeMediaSourceId})` (`engine.acquire`). Path (a) needs no user activation in
 * the page, so it works from the hidden engine window.
 *
 * - An empty list means the user cancelled the portal (R1.8): a clean `cancelled`, no error.
 * - Without a portal (X11) every monitor is listed. With more than one, the in-app source picker
 *   asks which (R1.53, D-6; `chooseSource`, `windows/source-picker.ts`), starting on the last
 *   choice. Under `--auto-select-desktop-capture-source=<name>` (CI, §4.6.3) nothing is asked:
 *   the source with that name is used. One monitor is used without asking.
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
  /** Electron's `NativeImage`; present (and non-empty) only when thumbnails were asked for. */
  thumbnail?: { isEmpty(): boolean; toDataURL(): string };
}

/** Asks the user for a source (the in-app picker); resolves with its id, or null on cancel. */
export type ChooseSource = (
  sources: readonly DesktopSourceLike[],
  initialId: string | null,
) => Promise<string | null>;

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
  /**
   * No portal (X11): asks the user when several sources are listed. Leave it out where the
   * portal picks (Wayland) or the choice is automatic (`autoSelectName`).
   */
  chooseSource?: ChooseSource;
  /** `--auto-select-desktop-capture-source=<name>`: the source of this name, without asking. */
  autoSelectName?: string;
}

/** Thumbnail size for the in-app picker (16:9, enough for a 2-column grid at 1×). */
export const PICKER_THUMBNAIL_SIZE = { width: 320, height: 180 } as const;

/** The Chromium switch CI uses to choose the capture source by name (§4.6.3). */
export const AUTO_SELECT_SWITCH = 'auto-select-desktop-capture-source';

export type SourceDecision =
  | { kind: 'use'; source: DesktopSourceLike }
  | { kind: 'ask'; initialId: string }
  | { kind: 'none' };

/**
 * Which source to record, before any question (R1.53):
 * - nothing listed: none (a cancelled portal, R1.8);
 * - an auto-select name: the source with that name (exact, then case-insensitive substring),
 *   else the preferred or first one: CI never blocks on a picker;
 * - one source, or no way to ask: the preferred one when still listed, else the first;
 * - several and a picker: ask, starting on the preferred one when still listed.
 */
export function decideScreenSource(
  sources: readonly DesktopSourceLike[],
  options: { preferredSourceId?: string; autoSelectName?: string; canAsk: boolean },
): SourceDecision {
  const first = sources[0];
  if (!first) return { kind: 'none' };
  const preferred = sources.find((s) => s.id === options.preferredSourceId) ?? first;
  if (options.autoSelectName !== undefined) {
    const name = options.autoSelectName.toLowerCase();
    const named =
      sources.find((s) => s.name === options.autoSelectName) ??
      (name ? sources.find((s) => s.name.toLowerCase().includes(name)) : undefined);
    return { kind: 'use', source: named ?? preferred };
  }
  if (sources.length === 1 || !options.canAsk) return { kind: 'use', source: preferred };
  return { kind: 'ask', initialId: preferred.id };
}

/**
 * The picker options for `selectScreen` (main/index.ts): an auto-select name under the CI
 * switch, the in-app picker where no portal picks, nothing on the portal path (unchanged).
 */
export function screenPickerOptions(options: {
  portal: boolean;
  commandLine: { hasSwitch(name: string): boolean; getSwitchValue(name: string): string };
  choose: ChooseSource;
}): Pick<PickScreenOptions, 'chooseSource' | 'autoSelectName'> {
  if (options.commandLine.hasSwitch(AUTO_SELECT_SWITCH)) {
    return { autoSelectName: options.commandLine.getSwitchValue(AUTO_SELECT_SWITCH) };
  }
  return options.portal ? {} : { chooseSource: options.choose };
}

export async function pickScreenSource(
  getSources: GetSources,
  options: PickScreenOptions,
): Promise<ScreenPick> {
  const canAsk = options.chooseSource !== undefined && options.autoSelectName === undefined;
  let sources: DesktopSourceLike[];
  try {
    sources = await getSources({
      types: ['screen'],
      // Thumbnails only for the in-app picker: they cost a capture per monitor, and the portal
      // shows its own preview.
      thumbnailSize: canAsk ? { ...PICKER_THUMBNAIL_SIZE } : { width: 0, height: 0 },
      fetchWindowIcons: false,
    });
  } catch (error) {
    return { status: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
  const decision = decideScreenSource(sources, {
    canAsk,
    ...(options.preferredSourceId !== undefined
      ? { preferredSourceId: options.preferredSourceId }
      : {}),
    ...(options.autoSelectName !== undefined ? { autoSelectName: options.autoSelectName } : {}),
  });
  let source: DesktopSourceLike | undefined;
  if (decision.kind === 'use') source = decision.source;
  else if (decision.kind === 'ask' && options.chooseSource) {
    let chosen: string | null;
    try {
      chosen = await options.chooseSource(sources, decision.initialId);
    } catch (error) {
      return {
        status: 'failed',
        message: `source picker failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (chosen === null) return { status: 'cancelled' };
    source = sources.find((s) => s.id === chosen);
    // The list is fresh, so an unknown id is a fault of the picker, not a vanished monitor.
    if (!source)
      return { status: 'failed', message: `source picker returned unknown id ${chosen}` };
  }
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
