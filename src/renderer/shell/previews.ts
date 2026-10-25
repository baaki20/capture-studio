/**
 * Device previews for the setup panel (R1.5, R1.6): the device lists, a live camera preview with
 * its delivered frame rate (§9.3), and a mic level meter. Previews use `getUserMedia` in the shell
 * only to show what will be recorded; every hook returns `release()`, which the panel calls before
 * `rec.record` so the capture engine can open the devices itself.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { FrameRateMeter } from '../engine/encoder-select';
import { CAMERA_IDEAL } from '../engine/pipeline/constraints';

/** Meter refresh: about 15 Hz (R1.6 asks for at least 10). */
export const METER_INTERVAL_MS = 1000 / 15;
const FPS_REFRESH_MS = 500;

export interface DeviceOption {
  deviceId: string;
  label: string;
}

export interface DeviceLists {
  cameras: DeviceOption[];
  mics: DeviceOption[];
  /** False until enumeration finished. */
  ready: boolean;
}

function options(devices: MediaDeviceInfo[], kind: MediaDeviceKind, fallback: string) {
  return devices
    .filter((d) => d.kind === kind && d.deviceId !== '')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `${fallback} ${String(i + 1)}` }));
}

/**
 * Chromium hides device ids until the page has opened that kind of device once. With the mic set
 * to None the panel never opens it, so the list would stay empty and the mic could never be
 * chosen again. Open each hidden kind briefly (no preview), then enumerate again.
 */
async function unlockHiddenKinds(devices: MediaDeviceInfo[]): Promise<boolean> {
  const hidden = (kind: MediaDeviceKind) =>
    devices.some((d) => d.kind === kind && d.deviceId === '');
  const audio = hidden('audioinput');
  const video = hidden('videoinput');
  if (!audio && !video) return false;
  let unlocked = false;
  for (const constraints of [audio && { audio: true }, video && { video: true }]) {
    if (!constraints) continue;
    try {
      stopStream(await navigator.mediaDevices.getUserMedia(constraints));
      unlocked = true;
    } catch (error) {
      console.warn('setup: could not unlock device list', constraints, error);
    }
  }
  return unlocked;
}

/** Cameras and microphones, kept current when devices are plugged in or out. */
export function useDevices(): DeviceLists {
  const [lists, setLists] = useState<DeviceLists>({ cameras: [], mics: [], ready: false });
  useEffect(() => {
    let cancelled = false;
    let triedUnlock = false;
    const refresh = async () => {
      let devices = await navigator.mediaDevices.enumerateDevices();
      if (!triedUnlock) {
        triedUnlock = true;
        if (await unlockHiddenKinds(devices))
          devices = await navigator.mediaDevices.enumerateDevices();
      }
      if (cancelled) return;
      setLists({
        cameras: options(devices, 'videoinput', 'Camera'),
        mics: options(devices, 'audioinput', 'Microphone'),
        ready: true,
      });
    };
    const refreshSafely = () => {
      // Not ready: a failed enumeration must not reset the saved devices to "none".
      refresh().catch((error: unknown) => console.warn('setup: enumerateDevices failed', error));
    };
    refreshSafely();
    navigator.mediaDevices.addEventListener('devicechange', refreshSafely);
    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener('devicechange', refreshSafely);
    };
  }, []);
  return lists;
}

function stopStream(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export interface CameraPreview {
  stream: MediaStream | null;
  /** Delivered frame rate of the preview (§9.3), null while measuring. */
  fps: number | null;
  error: string | null;
  release(): void;
}

/**
 * Opens the camera with the same constraints the engine uses (720p30 ideal), so the frame rate
 * shown is the one the recording will get. Attach `videoRef` to the preview `<video>`.
 */
export function useCameraPreview(
  deviceId: string | null,
  enabled: boolean,
  videoRef: RefObject<HTMLVideoElement | null>,
): CameraPreview {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [fps, setFps] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = useRef<MediaStream | null>(null);

  const release = useCallback(() => {
    stopStream(current.current);
    current.current = null;
  }, []);

  useEffect(() => {
    if (!enabled || !deviceId) return;
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({
        audio: false,
        video: {
          deviceId: { exact: deviceId },
          width: { ideal: CAMERA_IDEAL.width },
          height: { ideal: CAMERA_IDEAL.height },
          frameRate: { ideal: CAMERA_IDEAL.frameRate },
        },
      })
      .then(
        (opened) => {
          if (cancelled) {
            stopStream(opened);
            return;
          }
          current.current = opened;
          setError(null);
          setStream(opened);
        },
        (e: unknown) => {
          if (!cancelled) setError(describe(e));
        },
      );
    return () => {
      cancelled = true;
      release();
      setStream(null);
      setFps(null);
    };
  }, [deviceId, enabled, release]);

  // Delivered rate from the frames the preview presents.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream) return;
    video.srcObject = stream;
    const meter = new FrameRateMeter(30);
    let handle = 0;
    let last = 0;
    const onFrame: VideoFrameRequestCallback = (now) => {
      meter.onFrame(now * 1000);
      if (now - last >= FPS_REFRESH_MS) {
        last = now;
        setFps(meter.fps);
      }
      handle = video.requestVideoFrameCallback(onFrame);
    };
    handle = video.requestVideoFrameCallback(onFrame);
    return () => {
      video.cancelVideoFrameCallback(handle);
      video.srcObject = null;
    };
  }, [stream, videoRef]);

  return { stream, fps, error, release };
}

export interface MicProcessing {
  ec: boolean;
  ns: boolean;
  agc: boolean;
}

export interface MicMeter {
  /** Linear peak 0–1, or null when no mic is open. */
  peak: number | null;
  error: string | null;
  release(): void;
}

/** A live level for the chosen mic, with the chosen processing, at about 15 Hz. */
export function useMicMeter(
  deviceId: string | null,
  processing: MicProcessing,
  enabled: boolean,
): MicMeter {
  const [peak, setPeak] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const { ec, ns, agc } = processing;

  const release = useCallback(() => {
    cleanup.current?.();
    cleanup.current = null;
  }, []);

  useEffect(() => {
    if (!enabled || !deviceId) return;
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({
        video: false,
        audio: {
          deviceId: { exact: deviceId },
          echoCancellation: ec,
          noiseSuppression: ns,
          autoGainControl: agc,
        },
      })
      .then(
        (stream) => {
          if (cancelled) {
            stopStream(stream);
            return;
          }
          const context = new AudioContext();
          const analyser = context.createAnalyser();
          // 4096 frames (85 ms at 48 kHz) span the whole meter interval, so no peak slips between
          // two readings.
          analyser.fftSize = 4096;
          context.createMediaStreamSource(stream).connect(analyser);
          void context.resume();
          const samples = new Float32Array(analyser.fftSize);
          const timer = setInterval(() => {
            analyser.getFloatTimeDomainData(samples);
            let max = 0;
            for (const sample of samples) {
              const v = Math.abs(sample);
              if (v > max) max = v;
            }
            setPeak(max);
          }, METER_INTERVAL_MS);
          setError(null);
          cleanup.current = () => {
            clearInterval(timer);
            stopStream(stream);
            void context.close();
          };
        },
        (e: unknown) => {
          if (!cancelled) setError(describe(e));
        },
      );
    return () => {
      cancelled = true;
      release();
      setPeak(null);
    };
  }, [deviceId, enabled, ec, ns, agc, release]);

  return { peak, error, release };
}
