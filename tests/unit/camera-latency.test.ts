import { describe, expect, it } from 'vitest';
import {
  MAX_CAMERA_LATENCY_US,
  cameraCaptureLatencyUs,
} from '../../src/shared/recording/camera-latency';

describe('camera capture latency', () => {
  it('is one frame interval at 30 fps and above', () => {
    expect(cameraCaptureLatencyUs(30)).toBe(33_333);
    expect(cameraCaptureLatencyUs(60)).toBe(16_667);
  });

  it('stays at one 30 fps interval when a dim room slows the camera', () => {
    // Live W1, 2026-11-08: 16.5 fps, claps put the latency at about 33 ms.
    expect(cameraCaptureLatencyUs(16.46)).toBe(MAX_CAMERA_LATENCY_US);
    expect(cameraCaptureLatencyUs(5)).toBe(MAX_CAMERA_LATENCY_US);
  });

  it('assumes the bound when the rate is unknown', () => {
    expect(cameraCaptureLatencyUs(null)).toBe(MAX_CAMERA_LATENCY_US);
    expect(cameraCaptureLatencyUs(0)).toBe(MAX_CAMERA_LATENCY_US);
  });
});
