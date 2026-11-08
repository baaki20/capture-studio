import { describe, expect, it } from 'vitest';
import {
  MAX_CAMERA_LATENCY_US,
  cameraCaptureLatencyUs,
} from '../../src/shared/recording/camera-latency';

describe('camera capture latency', () => {
  it('is one frame interval plus half the exposure', () => {
    // The live webcam: 30 fps, exposureTime 157 (× 100 µs = 15.7 ms).
    expect(cameraCaptureLatencyUs({ frameRate: 30, exposureTime: 157 })).toBe(41_183);
    expect(cameraCaptureLatencyUs({ frameRate: 60, exposureTime: 50 })).toBe(19_167);
  });

  it('assumes the longest exposure (one frame) when the camera does not report it', () => {
    expect(cameraCaptureLatencyUs({ frameRate: 30, exposureTime: null })).toBe(50_000);
  });

  it('caps the exposure at one frame interval and falls back to 30 fps', () => {
    expect(cameraCaptureLatencyUs({ frameRate: 30, exposureTime: 5_000 })).toBe(50_000);
    expect(cameraCaptureLatencyUs({ frameRate: null, exposureTime: 157 })).toBe(41_183);
    expect(cameraCaptureLatencyUs({ frameRate: 0, exposureTime: 0 })).toBe(50_000);
  });

  it('never exceeds the bound, even for a very slow camera', () => {
    expect(cameraCaptureLatencyUs({ frameRate: 2, exposureTime: null })).toBe(
      MAX_CAMERA_LATENCY_US,
    );
  });
});
