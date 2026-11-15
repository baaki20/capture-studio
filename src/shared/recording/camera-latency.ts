/**
 * Camera capture latency: how long before its timestamp a webcam frame was actually seen.
 *
 * Chromium on Linux stamps a camera frame when the driver hands it over (measured on GNOME
 * Wayland: 2.5–3 ms before it reaches the page), not when the light hit the sensor. Exposure,
 * sensor readout and the USB transfer all happen before that. The camera shares the screen's
 * capture time domain (`sync-calibrator.ts`), so without this correction every camera frame lands
 * that much late against the screen and the audio (the live W1 check measured camera ↔ mic at
 * 60–80 ms against a 60 ms limit).
 *
 * The model: readout and transfer take about one frame interval, and the frame's moment is the
 * middle of its exposure, half the exposure time before readout starts. When the camera does not
 * report its exposure, the longest it can be (one frame interval) is assumed, halved.
 *
 * Live W1 (screen flashes seen by the camera, 2026-11-14): at 16.6 fps this model gives about
 * 68 ms and would bring camera ↔ mic to about 41 ms, the display's own latency (15–30 ms)
 * included. A one-frame model capped at 33 ms was tried in between, from one clap measurement;
 * claps proved unreliable on real hands (per-clap −281 to −34 ms), and with it W1 measured 75 ms.
 *
 * `startOffsetUs` is moved earlier by the result and it is recorded as `sync.captureLatencyUs`,
 * the counterpart of system audio's `outputLatencyUs`.
 */

/** The frame rate assumed when the camera's delivered rate is unknown. */
const FALLBACK_FPS = 30;
/** Upper bound, so a bogus reported exposure or rate cannot move the camera far. */
export const MAX_CAMERA_LATENCY_US = 150_000;

export interface CameraTiming {
  /** Delivered (or requested) frames per second; null when unknown. */
  frameRate: number | null;
  /** `MediaTrackSettings.exposureTime`, in its unit of 100 µs; null when not reported. */
  exposureTime: number | null;
}

export function cameraCaptureLatencyUs(timing: CameraTiming): number {
  const fps = timing.frameRate !== null && timing.frameRate > 0 ? timing.frameRate : FALLBACK_FPS;
  const frameUs = 1_000_000 / fps;
  const exposureUs =
    timing.exposureTime !== null && timing.exposureTime > 0
      ? Math.min(timing.exposureTime * 100, frameUs)
      : frameUs;
  return Math.round(Math.min(MAX_CAMERA_LATENCY_US, frameUs + exposureUs / 2));
}
