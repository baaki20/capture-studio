/** Capability keys (§1.4), kept free of zod so renderers can import them cheaply. */

/** Every key of the §1.4 table, in table order. */
export const CAPABILITY_KEYS = [
  'capture.screen.source',
  'capture.screen.restoreToken',
  'capture.screen.allMonitors',
  'capture.window.enumerate',
  'capture.region.onScreenOverlay',
  'capture.cursor.hide',
  'capture.cursor.track',
  'capture.screenshot.silent',
  'audio.system',
  'audio.mic',
  'video.camera',
  'encode.webcodecs.hw',
  'encode.ffmpeg.hw',
  'hotkeys.global',
  'ui.tray',
  'ui.alwaysOnTop',
  'ui.windowPositioning',
  'ui.excludeFromCapture',
  'ui.customToast',
  'input.synthetic',
  'window.foregroundInfo',
  'window.manipulate',
  'colorPicker.screen',
  'clipboard.writeImageUnfocused',
  'secrets.persistent',
  'startup.login',
  'shell.contextMenu',
  'ocr.native',
] as const;

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];
