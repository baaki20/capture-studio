/**
 * Camera capture latency: how long before its timestamp a webcam frame was actually seen.
 *
 * Chromium on Linux stamps a camera frame when the driver hands it over (measured on GNOME
 * Wayland: 2.5–3 ms before it reaches the page), not when the light hit the sensor. The sensor
 * readout and the USB transfer happen before that. The camera shares the screen's capture time
 * domain (`sync-calibrator.ts`), so without this correction every camera frame lands that much
 * late against the screen and the audio.
 *
 * The model is one frame interval, at most one 30 fps interval: readout and transfer run at the
 * sensor's own rate even when a long exposure in a dim room slows the delivered rate. Measured
 * live on an integrated webcam (claps, camera ↔ mic before the correction): about 33 ms at
 * 16.5 fps, 20–45 ms at 30 fps. An earlier model (a full frame interval plus half the exposure)
 * gave 68 ms at 16.5 fps and overcorrected by 35 ms, so the exposure is not added.
 * `startOffsetUs` is moved earlier by the result and it is recorded as `sync.captureLatencyUs`,
 * the counterpart of system audio's `outputLatencyUs`.
 */

/** Readout and transfer at the sensor's usual top rate (30 fps). */
export const MAX_CAMERA_LATENCY_US = 33_333;

/** `frameRate`: delivered (or requested) frames per second; null when unknown. */
export function cameraCaptureLatencyUs(frameRate: number | null): number {
  const frameUs = frameRate !== null && frameRate > 0 ? 1_000_000 / frameRate : Infinity;
  return Math.round(Math.min(frameUs, MAX_CAMERA_LATENCY_US));
}
