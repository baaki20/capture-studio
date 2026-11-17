/**
 * Where the end-to-end tests can run (P3 step 10, acceptance a). Linux needs an X server (Xvfb in
 * CI); Windows and macOS always have a display.
 *
 * - `HAS_DISPLAY`: the app and its editor, export and preview (no screen capture).
 * - `CAN_CAPTURE`: recording the screen too. Linux X11 and Windows can; GitHub's macOS runners
 *   cannot grant Screen Recording, so recording on macOS is a manual check
 *   (`docs/macos-manual-checklist.md`).
 */
export const HAS_DISPLAY =
  process.platform === 'linux'
    ? Boolean(process.env.DISPLAY)
    : process.platform === 'win32' || process.platform === 'darwin';

export const CAN_CAPTURE =
  process.platform === 'linux' ? Boolean(process.env.DISPLAY) : process.platform === 'win32';
