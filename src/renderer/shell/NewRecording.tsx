import { useEffect, useRef, useState } from 'react';
import type { CapabilityReport } from '../../shared/capabilities/types';
import type { EventPayload, RecorderConfig } from '../../shared/ipc/contract';
import { makeFileName } from '../../shared/naming/name-pattern';
import { PROJECT_EXTENSION } from '../../shared/project/schema';
import type { Settings } from '../../shared/settings/schema';
import { Meter } from '../common/Meter';
import { formatFps } from '../common/recorder-format';
import styles from './NewRecording.module.css';
import { useCameraPreview, useDevices, useMicMeter } from './previews';

type RecState = EventPayload<'rec.state'>['state'];

/** States in which the setup panel is editable and previews may hold the devices. */
const RESTING: readonly RecState[] = ['idle', 'configuring', 'completed', 'aborted', 'failed'];

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function configFrom(settings: Settings): RecorderConfig {
  const r = settings.recorder;
  return {
    captureMode: r.captureMode,
    cameraId: r.cameraId,
    micId: r.micId,
    systemAudio: r.systemAudio,
    micProcessing: { ...r.micProcessing },
    fps: r.fps,
    quality: r.quality,
    countdownSec: r.countdownSec,
  };
}

/** Last system-audio level from `rec.levels`, while the meter runs. */
function useSystemLevel(enabled: boolean): number | null {
  const api = window.captureStudio;
  const [peak, setPeak] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const off = api.rec.onLevels((levels) => {
      if (levels.system !== undefined) setPeak(levels.system);
    });
    api.rec.monitorSystem(true).catch((e: unknown) => console.warn('setup: system meter', e));
    return () => {
      off();
      setPeak(null);
      api.rec.monitorSystem(false).catch(() => undefined);
    };
  }, [api, enabled]);
  return enabled ? (peak ?? 0) : null;
}

interface Props {
  recState: RecState;
}

/**
 * The New Recording panel (R1.5–R1.8): capture mode, camera with live preview and its delivered
 * frame rate, microphone with a live meter, system audio (disabled with the reason when
 * unavailable), mic processing, frame rate, quality and countdown. Choices persist through
 * `rec.configure` (R1.6); Record releases the previews and starts (`rec.record`).
 */
export function NewRecording({ recState }: Props) {
  const api = window.captureStudio;
  const [settings, setSettings] = useState<Settings | null>(null);
  const [config, setConfig] = useState<RecorderConfig | null>(null);
  const [caps, setCaps] = useState<CapabilityReport | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notices, setNotices] = useState<string[]>([]);
  const devices = useDevices();
  const video = useRef<HTMLVideoElement>(null);

  const resting = RESTING.includes(recState);
  const previews = resting && !starting;

  useEffect(() => {
    api.settings.get().then(
      (loaded) => {
        setSettings(loaded);
        setConfig(configFrom(loaded));
      },
      (e: unknown) => setError(errorText(e)),
    );
    api.caps.get().then(setCaps, (e: unknown) => setError(errorText(e)));
    const offCaps = api.caps.onChanged(setCaps);
    const offNotice = api.rec.onNotice((n) => {
      if (n.level !== 'info') setNotices((list) => [...list.slice(-2), n.message]);
    });
    return () => {
      offCaps();
      offNotice();
    };
  }, [api]);

  const system = caps?.capabilities['audio.system'];
  const systemAvailable = system?.state === 'available' || system?.state === 'degraded';

  const camera = useCameraPreview(config?.cameraId ?? null, previews, video);
  const mic = useMicMeter(
    config?.micId ?? null,
    config?.micProcessing ?? { ec: false, ns: false, agc: false },
    previews,
  );
  const systemPeak = useSystemLevel(previews && systemAvailable && (config?.systemAudio ?? false));

  /** Applies a change and persists it (R1.6). */
  const update = (patch: Partial<RecorderConfig>) => {
    if (!config) return;
    const next = { ...config, ...patch };
    setConfig(next);
    if (RESTING.includes(recState)) {
      api.rec.configure(next).catch((e: unknown) => setError(errorText(e)));
    }
  };

  // R1.6: a saved device that is no longer connected falls back to "none", with a notice.
  useEffect(() => {
    if (!config || !devices.ready || !RESTING.includes(recState)) return;
    const missing: string[] = [];
    const patch: Partial<RecorderConfig> = {};
    if (config.cameraId && !devices.cameras.some((d) => d.deviceId === config.cameraId)) {
      patch.cameraId = null;
      missing.push('The saved camera is not connected; camera is set to None.');
    }
    if (config.micId && !devices.mics.some((d) => d.deviceId === config.micId)) {
      patch.micId = null;
      missing.push('The saved microphone is not connected; microphone is set to None.');
    }
    if (missing.length === 0) return;
    const next = { ...config, ...patch };
    api.rec.configure(next).then(
      () => {
        setConfig(next);
        setNotices((list) => [...list, ...missing].slice(-3));
      },
      (e: unknown) => setError(errorText(e)),
    );
  }, [api, config, devices, recState]);

  if (!config || !settings) {
    return (
      <section className={styles.page}>{error ? <p role="alert">{error}</p> : 'Loading…'}</section>
    );
  }

  const record = async () => {
    setError(null);
    setStarting(true);
    // The engine opens the camera and mic itself: free them first.
    camera.release();
    mic.release();
    try {
      await api.rec.monitorSystem(false);
      await api.rec.configure(config);
      const result = await api.rec.record();
      // A cancelled portal, picker or countdown returns here quietly (R1.8, R1.10).
      if (result.status === 'failed') setError(result.message);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setStarting(false);
    }
  };

  const disabled = !resting || starting;
  const name = makeFileName(settings.namePattern, {
    now: new Date(),
    increment: settings.nameIncrement,
  }).text;
  const linked = config.cameraId !== null && config.micId !== null;

  return (
    <section className={styles.page} aria-labelledby="setup-title" data-testid="setup-panel">
      <header className={styles.header}>
        <h2 id="setup-title">New recording</h2>
        <button
          type="button"
          className={styles.record}
          data-testid="record-button"
          disabled={disabled}
          onClick={() => void record()}
        >
          {starting ? 'Starting…' : 'Record'}
        </button>
      </header>
      {!resting ? (
        <p className={styles.status} data-testid="setup-busy">
          A recording is in progress ({recState}). Use the controls window, the tray or{' '}
          <code>capture-studio --action stop-recording</code>.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      {notices.length > 0 ? (
        <ul className={styles.notices} data-testid="setup-notices">
          {notices.map((text, i) => (
            <li key={`${String(i)}-${text}`}>{text}</li>
          ))}
        </ul>
      ) : null}

      <fieldset className={styles.group} disabled={disabled}>
        <legend>Screen</legend>
        <p className={styles.muted}>
          Always recorded. After Record, choose the screen in the system dialog.
        </p>
        <div className={styles.choices} role="radiogroup" aria-label="Capture mode">
          <label>
            <input
              type="radio"
              name="captureMode"
              checked={config.captureMode === 'fullscreen'}
              onChange={() => update({ captureMode: 'fullscreen' })}
            />
            Full screen
          </label>
          <label>
            <input
              type="radio"
              name="captureMode"
              checked={config.captureMode === 'region'}
              onChange={() => update({ captureMode: 'region' })}
            />
            Region
          </label>
        </div>
      </fieldset>

      <div className={styles.columns}>
        <fieldset className={styles.group} disabled={disabled}>
          <legend>Face (camera)</legend>
          <label className={styles.field}>
            Camera
            <select
              data-testid="camera-select"
              value={config.cameraId ?? ''}
              onChange={(e) => update({ cameraId: e.target.value || null })}
            >
              <option value="">None</option>
              {devices.cameras.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
          <div className={styles.preview}>
            {config.cameraId && previews ? (
              <video
                ref={video}
                className={styles.video}
                data-testid="camera-preview"
                autoPlay
                muted
                playsInline
              />
            ) : (
              <span className={styles.muted}>
                {config.cameraId ? 'Preview paused' : 'No camera'}
              </span>
            )}
          </div>
          {config.cameraId ? (
            <p className={styles.muted}>
              Delivered: <span data-testid="camera-fps">{formatFps(camera.fps)}</span>
              {camera.fps !== null && camera.fps < config.fps * 0.9
                ? ' (below the requested rate; dropped frames are judged against this rate)'
                : ''}
            </p>
          ) : null}
          {camera.error ? <p className={styles.error}>Camera: {camera.error}</p> : null}
        </fieldset>

        <fieldset className={styles.group} disabled={disabled}>
          <legend>Voice and system audio</legend>
          <label className={styles.field}>
            Microphone
            <select
              data-testid="mic-select"
              value={config.micId ?? ''}
              onChange={(e) => update({ micId: e.target.value || null })}
            >
              <option value="">None</option>
              {devices.mics.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
          <Meter
            label="Mic"
            peak={config.micId && previews ? (mic.peak ?? 0) : null}
            testId="mic-meter"
          />
          {mic.error ? <p className={styles.error}>Microphone: {mic.error}</p> : null}
          <div className={styles.choices} aria-label="Microphone processing">
            <label>
              <input
                type="checkbox"
                checked={config.micProcessing.ec}
                onChange={(e) =>
                  update({ micProcessing: { ...config.micProcessing, ec: e.target.checked } })
                }
              />
              Echo cancellation
            </label>
            <label>
              <input
                type="checkbox"
                checked={config.micProcessing.ns}
                onChange={(e) =>
                  update({ micProcessing: { ...config.micProcessing, ns: e.target.checked } })
                }
              />
              Noise suppression
            </label>
            <label>
              <input
                type="checkbox"
                checked={config.micProcessing.agc}
                onChange={(e) =>
                  update({ micProcessing: { ...config.micProcessing, agc: e.target.checked } })
                }
              />
              Auto gain
            </label>
          </div>
          <label className={styles.toggle}>
            <input
              type="checkbox"
              data-testid="system-audio-toggle"
              checked={config.systemAudio && systemAvailable}
              disabled={!systemAvailable}
              onChange={(e) => update({ systemAudio: e.target.checked })}
            />
            System audio
          </label>
          {systemAvailable ? (
            <Meter label="System" peak={systemPeak} testId="system-meter" />
          ) : (
            <p className={styles.muted} data-testid="system-audio-reason">
              Unavailable: {system?.reason ?? 'checking…'}
            </p>
          )}
          <p className={styles.muted} data-testid="linked-hint">
            {linked
              ? 'Camera and microphone are recorded as one linked Face + Voice component; the editor moves and trims them together.'
              : 'Choose a camera and a microphone to record them as a linked Face + Voice component.'}
          </p>
        </fieldset>
      </div>

      <fieldset className={`${styles.group ?? ''} ${styles.row ?? ''}`} disabled={disabled}>
        <legend>Output</legend>
        <label className={styles.field}>
          Frame rate
          <select
            data-testid="fps-select"
            value={config.fps}
            onChange={(e) => update({ fps: e.target.value === '60' ? 60 : 30 })}
          >
            <option value={30}>30 fps</option>
            <option value={60}>60 fps</option>
          </select>
        </label>
        <label className={styles.field}>
          Quality
          <select
            data-testid="quality-select"
            value={config.quality}
            onChange={(e) => update({ quality: e.target.value === 'high' ? 'high' : 'standard' })}
          >
            <option value="standard">Standard</option>
            <option value="high">High</option>
          </select>
        </label>
        <label className={styles.field}>
          Countdown
          <select
            data-testid="countdown-select"
            value={config.countdownSec}
            onChange={(e) => {
              const value = Number(e.target.value);
              update({ countdownSec: value === 0 ? 0 : value === 5 ? 5 : 3 });
            }}
          >
            <option value={0}>None</option>
            <option value={3}>3 s</option>
            <option value={5}>5 s</option>
          </select>
        </label>
        <p className={styles.muted}>
          Screens larger than 2560 × 1440 are recorded scaled to fit 1440p.
          {config.fps === 60 ? ' 60 fps is beyond the 1440p30 target and may drop frames.' : ''}
        </p>
      </fieldset>

      <p className={styles.muted}>
        Saves as <strong data-testid="name-preview">{name}</strong>
        {PROJECT_EXTENSION} in {settings.projectsDir}
      </p>
    </section>
  );
}
