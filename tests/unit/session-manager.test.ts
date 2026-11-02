/**
 * Session manager with a fake capture engine and a fake media utility (§4.3.1, §4.3.5): happy
 * path, pause/resume, restart, abort, screen ended, camera ended, disk low, engine failure,
 * portal and countdown cancel, and the action bus.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActionBus } from '../../src/main/action-bus';
import { ProjectRootRegistry } from '../../src/main/projects/media-protocol';
import { ProjectStore } from '../../src/main/projects/project-store';
import { readLock, readSessionLog } from '../../src/main/recording/assemble';
import { selectScreenSource } from '../../src/main/screen-source';
import {
  SessionManager,
  type EngineLike,
  type SessionEvents,
  type SessionManagerDeps,
  type UtilityLike,
} from '../../src/main/recording/session-manager';
import type {
  EngineCommandChannel,
  EngineCommandPayload,
  EngineCommandResponse,
  EnginePorts,
  EventPayload,
  RecorderConfig,
  StreamKind,
} from '../../src/shared/ipc/contract';
import {
  SyncCheckpointsSchema,
  type ClockOffset,
  type FinalizedStream,
  type JobKind,
  type JobResult,
  type JobSpec,
  type MediaUtilityEvent,
  type SystemAudioResult,
} from '../../src/shared/ipc/media-utility';
import { ProjectV1Schema, type ProjectV1 } from '../../src/shared/project/schema';
import { createDefaultSettings, type Settings } from '../../src/shared/settings/schema';

const T0 = 1_761_300_000_000_000; // engine clock µs at t0 (absolute, like performance.timeOrigin)
const UTILITY_OFFSET = 1_500; // utility − engine
const S = 1_000_000;

// ---------------------------------------------------------------------------------------------
// Fakes

class FakeUtility implements UtilityLike {
  readonly listeners = new Set<(event: MediaUtilityEvent) => void>();
  readonly opened: { streamId: string; kind: StreamKind; dir: string }[] = [];
  readonly closed: string[] = [];
  readonly jobs: JobSpec[] = [];
  readonly systemCalls: { type: string; atUs?: number }[] = [];
  system: { captureId: string; dir: string } | null = null;
  /** File durations per kind (µs). */
  durations: Partial<Record<StreamKind, number>> = {};
  failFinalize = false;

  emit(event: MediaUtilityEvent): void {
    for (const l of [...this.listeners]) l(event);
  }

  onEvent(listener: (event: MediaUtilityEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  openStream(streamId: string, kind: StreamKind, dir: string): unknown {
    this.opened.push({ streamId, kind, dir });
    void fs.writeFile(path.join(dir, `${kind}.rec.mp4`), 'fragments');
    return { port: streamId };
  }

  /** The engine closed its muxers: the utility confirms each stream. */
  confirmClosed(): void {
    for (const { streamId } of this.opened) {
      this.emit({
        type: 'stream.closed',
        streamId,
        stats: { bytesWritten: 9, writes: 1, outOfOrder: 0, size: 9, fsyncs: 1, lastFsyncAt: null },
      });
    }
  }

  closeStream(streamId: string): void {
    this.closed.push(streamId);
  }

  attachClock(): unknown {
    return { port: 'clock' };
  }

  measureClockOffset(): Promise<ClockOffset | null> {
    return Promise.resolve({ offsetUs: 99, rttUs: 50, samples: 5 });
  }

  startSystemAudio(captureId: string, dir: string): void {
    this.system = { captureId, dir };
    this.systemCalls.push({ type: 'start' });
    void fs.writeFile(path.join(dir, 'system.rec.mp4'), 'pcm');
    // First PCM 20 ms after t0, on the utility clock.
    this.emit({
      type: 'system.first-audio',
      captureId,
      firstSampleUs: T0 + UTILITY_OFFSET + 20_000,
    });
  }

  pauseSystemAudio(_captureId: string, atUs?: number): void {
    this.systemCalls.push({ type: 'pause', ...(atUs === undefined ? {} : { atUs }) });
  }

  resumeSystemAudio(_captureId: string, atUs?: number): void {
    this.systemCalls.push({ type: 'resume', ...(atUs === undefined ? {} : { atUs }) });
  }

  stopSystemAudio(captureId: string): Promise<SystemAudioResult> {
    this.systemCalls.push({ type: 'stop' });
    const dir = this.system?.dir ?? '';
    return Promise.resolve({
      path: path.join(dir, 'system.rec.mp4'),
      syncPath: path.join(dir, 'system.sync.json'),
      samples: 480_000,
      silencedSamples: 0,
      gapSamples: 0,
      firstSampleUs: T0 + UTILITY_OFFSET + 20_000,
      checkpoints: 10,
      exitCode: captureId ? 0 : null,
    });
  }

  async runJob<K extends JobKind>(spec: Extract<JobSpec, { kind: K }>): Promise<JobResult<K>> {
    const job: JobSpec = spec;
    this.jobs.push(job);
    if (job.kind === 'finalize') {
      if (this.failFinalize) throw new Error('ffmpeg exploded');
      const streams: FinalizedStream[] = [];
      for (const { kind } of job.streams) {
        const rec = path.join(job.dir, `${kind}.rec.mp4`);
        const out = path.join(job.dir, `${kind}.mp4`);
        const hasRec = await fs.access(rec).then(
          () => true,
          () => false,
        );
        if (hasRec) await fs.rename(rec, out);
        const sync = await fs
          .readFile(path.join(job.dir, `${kind}.sync.json`), 'utf8')
          .then((text) => SyncCheckpointsSchema.parse(JSON.parse(text)))
          .catch(() => null);
        const video = kind === 'screen' || kind === 'camera';
        streams.push({
          kind,
          path: out,
          ok: hasRec,
          error: hasRec ? null : 'missing',
          durationUs: hasRec ? (this.durations[kind] ?? 10 * S) : null,
          sizeBytes: 9,
          video: video
            ? {
                codec: 'h264',
                width: kind === 'screen' ? 1920 : 1280,
                height: kind === 'screen' ? 1080 : 720,
                frameRate: 30,
              }
            : null,
          audio: video ? null : { codec: 'opus', sampleRate: 48_000, channels: 2 },
          sync,
          recDeleted: hasRec,
        });
      }
      return { streams } as JobResult<K>;
    }
    if (job.kind === 'peaks') {
      return { output: job.output, pairs: 1, sampleRate: 8000, windowSamples: 80 } as JobResult<K>;
    }
    if (job.kind === 'thumbnails') {
      const index = {
        version: 1,
        mediaId: job.mediaId,
        intervalUs: 2 * S,
        tileWidth: 160,
        tileHeight: 90,
        columns: 10,
        rows: 10,
        count: 5,
        sheets: [`${job.mediaId}.thumbs.0.jpg`],
      };
      await fs.writeFile(
        path.join(job.outDir, `${job.mediaId}.thumbs.json`),
        JSON.stringify(index),
      );
      return {
        indexPath: path.join(job.outDir, `${job.mediaId}.thumbs.json`),
        index,
      } as JobResult<K>;
    }
    throw new Error(`unexpected job ${job.kind}`);
  }
}

type Responder = {
  [C in EngineCommandChannel]?: (
    payload: EngineCommandPayload<C>,
  ) => EngineCommandResponse<C> | Promise<EngineCommandResponse<C>>;
};

class FakeEngine implements EngineLike {
  readonly calls: { channel: EngineCommandChannel; payload: unknown }[] = [];
  ports: { payload: EnginePorts; ports: readonly unknown[] }[] = [];
  readonly respond: Responder = {};
  pauseAt = T0 + 5 * S;
  /** Extra top-level fields of the `engine.stop` result (pauses, stoppedAtUs). */
  stopExtra: Record<string, unknown> = {};
  resumeAt = T0 + 8 * S;

  constructor(private readonly utility: FakeUtility) {}

  command<C extends EngineCommandChannel>(
    channel: C,
    payload: EngineCommandPayload<C>,
  ): Promise<EngineCommandResponse<C>> {
    this.calls.push({ channel, payload });
    const custom = this.respond[channel];
    if (custom) return Promise.resolve().then(() => custom(payload));
    return Promise.resolve(this.defaultResponse(channel, payload) as EngineCommandResponse<C>);
  }

  sendPorts(payload: EnginePorts, ports: readonly unknown[]): void {
    this.ports.push({ payload, ports });
  }

  count(channel: EngineCommandChannel): number {
    return this.calls.filter((c) => c.channel === channel).length;
  }

  private defaultResponse(channel: EngineCommandChannel, payload: unknown): unknown {
    switch (channel) {
      case 'engine.acquire': {
        const p = payload as EngineCommandPayload<'engine.acquire'>;
        return {
          status: 'ready',
          screen: { label: 'Entire screen', width: 1920, height: 1080, frameRate: 30 },
          camera: p.camera ? { label: 'HD Webcam', width: 1280, height: 720 } : null,
          mic: p.mic ? { label: 'Built-in Mic', sampleRate: 48_000, channels: 1 } : null,
        };
      }
      case 'engine.start':
        return {
          t0Us: T0,
          utilityClockOffsetUs: UTILITY_OFFSET,
          streams: [
            { kind: 'screen', encoder: { name: 'H.264 (software)', hardware: false } },
            { kind: 'camera', encoder: { name: 'H.264 (software)', hardware: false } },
            { kind: 'mic', encoder: { name: 'Opus', hardware: false } },
          ],
        };
      case 'engine.snapshot':
        return { width: 1920, height: 1080, png: new Uint8Array([137, 80, 78, 71]) };
      case 'engine.pause':
        return { atUs: this.pauseAt };
      case 'engine.resume':
        return { atUs: this.resumeAt };
      case 'engine.stop': {
        const reason = (payload as { reason: string }).reason;
        if (reason === 'stop') setTimeout(() => this.utility.confirmClosed(), 5);
        return {
          ...this.stopExtra,
          streams: [
            {
              kind: 'screen',
              framesIn: 300,
              framesEncoded: 297,
              framesDropped: 3,
              bytes: 1000,
              discontinuities: 0,
              queueDepth: 0,
              startOffsetUs: 8_000,
              calibration: { mode: 'shared', offsetUs: 123_456, clockHandshakeUs: null },
            },
            {
              kind: 'camera',
              framesIn: 200,
              framesEncoded: 200,
              framesDropped: 0,
              bytes: 500,
              discontinuities: 0,
              queueDepth: 0,
              startOffsetUs: 41_200,
              calibration: { mode: 'shared', offsetUs: 123_456 },
            },
            {
              kind: 'mic',
              framesIn: 470,
              framesEncoded: 470,
              framesDropped: 0,
              bytes: 300,
              discontinuities: 1,
              queueDepth: 0,
              startOffsetUs: 12_800,
              calibration: { mode: 'arrival-calibrated', offsetUs: -20_000_000 },
              nominalRate: 48_000,
              // 50 ppm fast session clock over 600 s: clean enough to apply.
              checkpoints: Array.from({ length: 601 }, (_, i) => [
                Math.round(12_800 + i * S * 1.00005),
                i * 48_000,
              ]),
            },
          ],
        };
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Harness

interface Harness {
  dir: string;
  manager: SessionManager;
  engine: FakeEngine;
  utility: FakeUtility;
  store: ProjectStore;
  settings: Settings;
  states: EventPayload<'rec.state'>[];
  notices: EventPayload<'rec.notice'>[];
  stats: EventPayload<'rec.stats'>[];
  levels: EventPayload<'rec.levels'>[];
  ready: { projectId: string; root: string; name: string }[];
  cachesReady: { projectId: string; root: string }[];
  libraryChanges: number;
  clock: { us: number };
  free: { bytes: number };
}

let work: string;

beforeEach(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-session-'));
});

afterEach(async () => {
  await fs.rm(work, { recursive: true, force: true });
});

const CONFIG: RecorderConfig = {
  captureMode: 'fullscreen',
  cameraId: 'cam-1',
  micId: 'mic-1',
  systemAudio: true,
  micProcessing: { ec: false, ns: false, agc: false },
  fps: 30,
  quality: 'standard',
  countdownSec: 0,
};

function harness(
  options: {
    systemAudio?: boolean;
    countdownTickMs?: number;
    pickRegion?: SessionManagerDeps['pickRegion'];
    selectScreen?: SessionManagerDeps['selectScreen'];
    generateCaches?: SessionManagerDeps['generateCaches'];
  } = {},
): Harness {
  const settings = createDefaultSettings({
    projectsDir: path.join(work, 'Projects'),
    exportsDir: path.join(work, 'Exports'),
  });
  const utility = new FakeUtility();
  const engine = new FakeEngine(utility);
  const store = new ProjectStore({ registry: new ProjectRootRegistry() });
  const clock = { us: 0 };
  const free = { bytes: 100e9 };
  const h: Harness = {
    dir: settings.projectsDir,
    engine,
    utility,
    store,
    settings,
    states: [],
    notices: [],
    stats: [],
    levels: [],
    ready: [],
    cachesReady: [],
    libraryChanges: 0,
    clock,
    free,
    manager: undefined as unknown as SessionManager,
  };
  const events: SessionEvents = {
    state: (p) => h.states.push(p),
    stats: (p) => h.stats.push(p),
    notice: (p) => h.notices.push(p),
    levels: (p) => h.levels.push(p),
    libraryChanged: () => {
      h.libraryChanges += 1;
    },
    projectReady: (info) => h.ready.push(info),
    cachesReady: (info) => h.cachesReady.push(info),
  };
  h.manager = new SessionManager({
    settings: {
      get: () => structuredClone(h.settings),
      patch: (patch) => {
        h.settings = {
          ...h.settings,
          ...patch,
          recorder: { ...h.settings.recorder, ...(patch.recorder as object) },
        } as Settings;
        return Promise.resolve(h.settings);
      },
    },
    store,
    utility,
    engine: () => Promise.resolve(engine),
    ...(options.generateCaches ? { generateCaches: options.generateCaches } : {}),
    selectScreen:
      options.selectScreen ??
      (() =>
        Promise.resolve({
          sourceId: 'screen:1:0',
          label: 'Entire screen',
          maxWidth: 3840,
          maxHeight: 2160,
        })),
    ...(options.pickRegion ? { pickRegion: options.pickRegion } : {}),
    systemAudioAvailable: () => options.systemAudio ?? true,
    systemAudioOutputLatencyUs: () => Promise.resolve(42_000),
    platform: () => ({
      os: 'linux',
      session: 'wayland',
      electron: '45.0.0',
      chromium: '156',
      ffmpeg: 'n9.0.2',
    }),
    appVersion: '0.1.0',
    events,
    now: () => new Date('2026-10-24T14:05:00.000Z'),
    nowUs: () => clock.us,
    freeBytes: () => Promise.resolve(free.bytes),
    countdownTickMs: options.countdownTickMs ?? 5,
    heartbeatMs: 50,
    diskIntervalMs: 20,
    streamCloseTimeoutMs: 500,
  });
  return h;
}

async function projectDirs(h: Harness): Promise<string[]> {
  return (await fs.readdir(h.dir).catch(() => [] as string[])).filter((n) =>
    n.endsWith('.cstudio'),
  );
}

async function readProject(root: string): Promise<ProjectV1> {
  return ProjectV1Schema.parse(
    JSON.parse(await fs.readFile(path.join(root, 'project.json'), 'utf8')),
  );
}

async function startRecording(h: Harness, config: RecorderConfig = CONFIG): Promise<string> {
  await h.manager.configure(config);
  const result = await h.manager.record();
  expect(result.status).toBe('started');
  const root = h.manager.activeRoot;
  if (!root) throw new Error('no project folder');
  return root;
}

const waitFor = async (predicate: () => boolean, ms = 2000): Promise<void> => {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

// ---------------------------------------------------------------------------------------------

describe('session manager', () => {
  it('records and finalizes a project (happy path)', async () => {
    const h = harness();
    const root = await startRecording(h);
    expect(h.manager.state).toBe('recording');
    expect(path.basename(root)).toBe('Lesson 2026-10-24 14-05.cstudio');

    // During recording: project.json(recording), lock, manifest log, ports and engine.start.
    const recordingDoc = await readProject(root);
    expect(recordingDoc.recording?.state).toBe('recording');
    const lock = await readLock(root);
    expect(lock).toMatchObject({ pid: process.pid, appVersion: '0.1.0' });
    expect(h.engine.ports).toHaveLength(1);
    expect(h.engine.ports[0]!.payload.clockPort).toBe(true);
    expect(h.engine.ports[0]!.payload.streams.map((s) => s.kind)).toEqual([
      'screen',
      'camera',
      'mic',
    ]);
    expect(h.engine.ports[0]!.ports).toHaveLength(4);
    expect(h.utility.opened.map((o) => o.dir)).toEqual(Array(3).fill(path.join(root, 'media')));
    expect(h.utility.system).not.toBeNull();
    const log = await readSessionLog(root);
    expect(log?.t0Us).toBe(T0);
    expect(log?.utilityClockOffsetUs).toBe(UTILITY_OFFSET);
    expect(log?.manifest.streams.map((s) => s.role)).toEqual([
      'screen',
      'camera',
      'microphone',
      'system-audio',
    ]);
    // System audio first sample at 20 ms session time, plus 42 ms output latency (utility clock converted).
    expect(log?.streams.find((s) => s.kind === 'system')?.startOffsetUs).toBe(62_000);

    h.clock.us = 10 * S;
    await h.manager.stop();
    expect(h.manager.state).toBe('completed');

    const doc = await readProject(root);
    expect(doc.recording?.state).toBe('complete');
    expect(doc.recording?.clockMode).toBe('hybrid');
    expect(doc.media.map((m) => [m.role, m.status, m.path])).toEqual([
      ['screen', 'ok', 'media/screen.mp4'],
      ['camera', 'ok', 'media/camera.mp4'],
      ['microphone', 'ok', 'media/mic.mp4'],
      ['system-audio', 'ok', 'media/system.mp4'],
    ]);
    const [screen, camera, mic, system] = doc.media;
    expect(screen!.startOffsetUs).toBe(8_000);
    expect(screen!.sync).toEqual({ mode: 'shared', offsetUs: 123_456 });
    expect(screen!.stats).toEqual({ framesEncoded: 297, framesDropped: 3 });
    expect(screen!.encoder).toEqual({ name: 'H.264 (software)', hardware: false });
    expect(camera!.device).toEqual({ label: 'HD Webcam' });
    expect(mic!.clockRatio).toBeCloseTo(1.00005, 6);
    expect(mic!.audio?.syncCheckpointsPath).toBe('media/mic.sync.json');
    expect(mic!.audio?.discontinuities).toBe(1);
    // First sample at 20 ms, shifted later by the sink's 42 ms output latency.
    expect(system!.startOffsetUs).toBe(62_000);
    expect(system!.sync).toEqual({
      mode: 'arrival-calibrated',
      offsetUs: 0,
      clockHandshakeUs: UTILITY_OFFSET,
      outputLatencyUs: 42_000,
    });

    // Finalize order: engine.stop → system stop → finalize; lock gone; events. Peaks and
    // thumbnails follow in the background (R1.20), peaks first.
    expect(h.utility.systemCalls.map((c) => c.type)).toEqual(['start', 'stop']);
    expect(h.utility.jobs[0]?.kind).toBe('finalize');
    await h.manager.cachesSettled();
    expect(h.utility.jobs.map((j) => j.kind)).toEqual([
      'finalize',
      'peaks',
      'peaks',
      'thumbnails',
      'thumbnails',
    ]);
    expect(h.cachesReady).toEqual([{ projectId: doc.id, root }]);
    expect(h.utility.closed).toEqual([]); // the engine closed every stream itself
    expect(await readLock(root)).toBeNull();
    expect(h.ready).toEqual([
      { projectId: doc.id, root, name: doc.name, afterRecording: 'open-editor' },
    ]);
    expect(h.libraryChanges).toBeGreaterThanOrEqual(2);
    expect(h.states.map((s) => s.state)).toEqual([
      'configuring',
      'acquiring',
      'countdown',
      'countdown',
      'recording',
      'recording',
      'finalizing',
      'completed',
    ]);
  });

  it('records pauses in session time and converts them for system audio', async () => {
    const h = harness();
    const root = await startRecording(h);
    h.clock.us = 5 * S;
    await h.manager.pause();
    expect(h.manager.state).toBe('paused');
    h.clock.us = 8 * S;
    await h.manager.resume();
    // At resume (8 s on main's clock) 5 s were recorded: the 3 s pause is left out.
    expect(h.states.at(-1)!.elapsedUs).toBe(5 * S);
    h.clock.us = 10 * S;
    await h.manager.stop();

    expect(h.utility.systemCalls).toEqual([
      { type: 'start' },
      { type: 'pause', atUs: T0 + 5 * S + UTILITY_OFFSET },
      { type: 'resume', atUs: T0 + 8 * S + UTILITY_OFFSET },
      { type: 'stop' },
    ]);
    const doc = await readProject(root);
    expect(doc.recording?.pauses).toEqual([{ startUs: 5 * S, endUs: 8 * S }]);
    const screenTrack = doc.timeline.tracks.find((t) => t.name === 'Screen')!;
    expect(
      screenTrack.clips.map((c) => [c.timelineStartUs, c.sourceStartUs, c.sourceEndUs]),
    ).toEqual([
      [8_000, 8_000, 5 * S],
      [5 * S, 8 * S, 10 * S + 8_000],
    ]);
  });

  it('restart discards the media, keeps the folder and records again', async () => {
    const h = harness();
    const root = await startRecording(h);
    const firstStreams = h.utility.opened.map((o) => o.streamId);
    await waitFor(() => h.utility.opened.length === 3);
    await h.manager.restart();
    expect(h.manager.state).toBe('recording');
    expect(h.manager.activeRoot).toBe(root);
    expect(h.engine.calls.filter((c) => c.channel === 'engine.stop').map((c) => c.payload)).toEqual(
      [{ reason: 'restart' }],
    );
    expect(h.engine.count('engine.start')).toBe(2);
    expect(h.engine.count('engine.acquire')).toBe(1); // same tracks
    const second = h.utility.opened.slice(3).map((o) => o.streamId);
    expect(second).toHaveLength(3);
    expect(second.some((id) => firstStreams.includes(id))).toBe(false);
    expect(h.utility.closed).toEqual(expect.arrayContaining(firstStreams));

    await h.manager.stop();
    expect(await projectDirs(h)).toEqual([path.basename(root)]);
    expect((await readProject(root)).recording?.state).toBe('complete');
  });

  it('abort deletes the project folder', async () => {
    const h = harness();
    const root = await startRecording(h);
    await h.manager.abort();
    expect(h.manager.state).toBe('aborted');
    expect(await fs.stat(root).catch(() => null)).toBeNull();
    expect(await projectDirs(h)).toEqual([]);
    expect(h.engine.calls.at(-1)).toEqual({ channel: 'engine.stop', payload: { reason: 'abort' } });
    expect(h.utility.systemCalls.at(-1)?.type).toBe('stop');
    // A new session can be configured afterwards.
    await h.manager.configure(CONFIG);
    expect(h.manager.state).toBe('configuring');
  });

  it('finalizes when the screen track ends (R1.15)', async () => {
    const h = harness();
    const root = await startRecording(h);
    h.manager.onTrackEnded({ kind: 'screen', reason: 'ended', atUs: T0 + 4 * S });
    await waitFor(() => h.manager.state === 'completed');
    await h.manager.settled();
    expect((await readProject(root)).recording?.state).toBe('complete');
    expect(h.notices.some((n) => n.stream === 'screen')).toBe(true);
  });

  it('keeps recording when the camera disconnects, marking it ended early (R1.16)', async () => {
    const h = harness();
    const root = await startRecording(h);
    h.manager.onTrackEnded({ kind: 'camera', reason: 'ended', atUs: T0 + 3 * S });
    expect(h.manager.state).toBe('recording');
    const notice = h.notices.find((n) => n.stream === 'camera');
    expect(notice?.message).toContain('HD Webcam');
    await h.manager.stop();
    const camera = (await readProject(root)).media.find((m) => m.role === 'camera');
    expect(camera?.endedEarly).toBe(true);
  });

  it('warns on low disk space and finalizes below the stop threshold (R1.17)', async () => {
    const h = harness();
    h.free.bytes = 1e9; // below the 2 GB warning
    const root = await startRecording(h);
    await waitFor(() => h.notices.some((n) => n.message.startsWith('Low disk space')));
    expect(h.manager.state).toBe('recording');
    h.free.bytes = 100e6; // below the 500 MB stop threshold
    await waitFor(() => h.manager.state === 'completed');
    await h.manager.settled();
    expect((await readProject(root)).recording?.state).toBe('complete');
    expect(h.notices.filter((n) => n.message.startsWith('Low disk space'))).toHaveLength(1);
  });

  it('fails cleanly when the engine cannot start, leaving no empty project', async () => {
    const h = harness();
    h.engine.respond['engine.start'] = () => {
      throw new Error('encoder configuration failed');
    };
    await h.manager.configure(CONFIG);
    const result = await h.manager.record();
    expect(result).toEqual({
      status: 'failed',
      message: 'Recording could not start: encoder configuration failed',
    });
    expect(h.manager.state).toBe('failed');
    expect(h.states.at(-1)?.failureReason).toContain('encoder configuration failed');
    expect(await projectDirs(h)).toEqual([]);
  });

  it('marks the project failed when finalize fails', async () => {
    const h = harness();
    const root = await startRecording(h);
    h.utility.failFinalize = true;
    await h.manager.stop();
    expect(h.manager.state).toBe('failed');
    const doc = await readProject(root);
    expect(doc.recording?.state).toBe('failed');
    expect(doc.recording?.failureReason).toContain('ffmpeg exploded');
    expect(await readLock(root)).toBeNull();
  });

  it('force-closes the streams when engine.stop fails, and still finalizes', async () => {
    const h = harness();
    const root = await startRecording(h);
    h.engine.respond['engine.stop'] = () => {
      throw new Error('engine window crashed');
    };
    await h.manager.stop();
    expect(h.manager.state).toBe('completed');
    expect(h.utility.closed).toHaveLength(3);
    expect((await readProject(root)).media).toHaveLength(4);
  });

  it('returns to configuring without a project when the portal is cancelled (R1.8)', async () => {
    const h = harness();
    h.engine.respond['engine.acquire'] = () => ({
      status: 'cancelled',
      screen: null,
      camera: null,
      mic: null,
    });
    await h.manager.configure(CONFIG);
    expect(await h.manager.record()).toEqual({ status: 'cancelled' });
    expect(h.manager.state).toBe('configuring');
    expect(await projectDirs(h)).toEqual([]);
  });

  it('returns to the panel without an error when getSources rejects on portal cancel (R1.8, D-1)', async () => {
    const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
    const h = harness({
      // What GNOME does: "ScreenCastPortal failed: 2", then getSources rejects.
      selectScreen: () =>
        selectScreenSource(
          () => Promise.reject(new Error('Failed to get sources.')),
          { fps: 30, portal: true },
          logger,
        ),
    });
    await h.manager.configure(CONFIG);
    expect(await h.manager.record()).toEqual({ status: 'cancelled' });
    expect(h.manager.state).toBe('configuring');
    expect(h.states.map((s) => s.state)).toEqual(['configuring', 'acquiring', 'configuring']);
    expect(h.states.every((s) => s.failureReason === null)).toBe(true);
    expect(h.notices.filter((n) => n.level === 'error')).toEqual([]);
    expect(await projectDirs(h)).toEqual([]);
  });

  it('opens the project before its peaks and thumbnails exist (R1.20, D-2)', async () => {
    let release: () => void = () => undefined;
    const caches: { projectId: string; media: number }[] = [];
    const h = harness({
      generateCaches: (projectId, _root, media) => {
        caches.push({ projectId, media: media.length });
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    const root = await startRecording(h);
    await h.manager.stop();
    // Ready and complete while the background pass is still running.
    const doc = await readProject(root);
    expect(doc.recording?.state).toBe('complete');
    expect(await readLock(root)).toBeNull();
    expect(h.ready).toHaveLength(1);
    expect(caches).toEqual([{ projectId: doc.id, media: 4 }]);
    expect(h.utility.jobs.map((j) => j.kind)).toEqual(['finalize']);
    expect(h.cachesReady).toEqual([]);
    release();
    await h.manager.cachesSettled();
    expect(h.cachesReady).toEqual([{ projectId: doc.id, root }]);
  });

  it('writes the mic capture-timestamp checkpoints apart, without fitting them', async () => {
    const h = harness();
    const original = h.engine.command.bind(h.engine);
    h.engine.command = (async (channel: EngineCommandChannel, payload: never) => {
      const result = (await original(channel, payload)) as Record<string, unknown>;
      if (channel !== 'engine.stop') return result;
      const streams = (result.streams as Record<string, unknown>[]).map((s) =>
        s.kind === 'mic'
          ? {
              ...s,
              // A slope far from the arrival series: it must not change the clock ratio.
              captureCheckpoints: Array.from({ length: 11 }, (_, i) => [i * S * 1.01, i * 48_000]),
            }
          : s,
      );
      return { ...result, streams };
    }) as typeof h.engine.command;
    const root = await startRecording(h);
    await h.manager.stop();
    const file = JSON.parse(
      await fs.readFile(path.join(root, 'media', 'mic.sync-capture.json'), 'utf8'),
    ) as { nominalRate: number; checkpoints: [number, number][] };
    expect(file.nominalRate).toBe(48_000);
    expect(file.checkpoints).toHaveLength(11);
    expect(file.checkpoints[10]).toEqual([Math.round(10 * S * 1.01), 480_000]);
    const mic = (await readProject(root)).media.find((m) => m.role === 'microphone');
    expect(mic?.clockRatio).toBeCloseTo(1.00005, 6);
    expect(mic?.audio?.syncCheckpointsPath).toBe('media/mic.sync.json');
    await h.manager.cachesSettled();
  });

  it('cancels the countdown without creating a project (R1.10)', async () => {
    const h = harness({ countdownTickMs: 50 });
    await h.manager.configure({ ...CONFIG, countdownSec: 3 });
    const recording = h.manager.record();
    await waitFor(() => h.manager.state === 'countdown');
    expect(h.states.at(-1)?.countdownRemainingSec).toBe(3);
    await h.manager.cancel();
    expect(await recording).toEqual({ status: 'cancelled' });
    expect(h.manager.state).toBe('configuring');
    expect(await projectDirs(h)).toEqual([]);
    expect(h.engine.count('engine.start')).toBe(0);
  });

  it('records without system audio when it is unavailable', async () => {
    const h = harness({ systemAudio: false });
    const root = await startRecording(h, { ...CONFIG, cameraId: null });
    await h.manager.stop();
    const doc = await readProject(root);
    expect(doc.media.map((m) => m.role)).toEqual(['screen', 'microphone']);
    expect(h.notices.some((n) => n.stream === 'system')).toBe(true);
  });

  it('uses the last region in region mode and keeps it as the screen crop', async () => {
    const h = harness();
    h.settings.recorder.lastRegion = {
      sourceWidth: 1920,
      sourceHeight: 1080,
      rect: { x: 100, y: 50, width: 1280, height: 720 },
    };
    const root = await startRecording(h, { ...CONFIG, captureMode: 'region' });
    const start = h.engine.calls.find((c) => c.channel === 'engine.start');
    expect(start?.payload).toMatchObject({ region: { x: 100, y: 50, width: 1280, height: 720 } });
    await h.manager.stop();
    const doc = await readProject(root);
    expect(doc.timeline.canvas).toMatchObject({ width: 1280, height: 720 });
  });

  it('asks the region picker with the stream size and remembers the chosen region (R1.9)', async () => {
    const asked: { width: number; height: number }[] = [];
    const h = harness({
      pickRegion: (size) => {
        asked.push(size);
        return Promise.resolve({ rect: { x: 10, y: 20, width: 640, height: 360 } });
      },
    });
    await startRecording(h, { ...CONFIG, captureMode: 'region' });
    expect(asked).toEqual([{ width: 1920, height: 1080 }]);
    expect(h.states.map((s) => s.state)).toContain('picking-region');
    const start = h.engine.calls.find((c) => c.channel === 'engine.start');
    expect(start?.payload).toMatchObject({ region: { x: 10, y: 20, width: 640, height: 360 } });
    expect(h.settings.recorder.lastRegion).toEqual({
      sourceWidth: 1920,
      sourceHeight: 1080,
      rect: { x: 10, y: 20, width: 640, height: 360 },
    });
    await h.manager.abort();
  });

  it('returns to the panel without a project when the region picker is cancelled (R1.9)', async () => {
    const h = harness({ pickRegion: () => Promise.resolve('cancelled') });
    await h.manager.configure({ ...CONFIG, captureMode: 'region' });
    expect(await h.manager.record()).toEqual({ status: 'cancelled' });
    expect(h.manager.state).toBe('configuring');
    expect(await projectDirs(h)).toEqual([]);
    expect(h.engine.count('engine.start')).toBe(0);
    expect(h.settings.recorder.lastRegion).toBeNull();
  });

  it('shows a notice when the region picker cannot open', async () => {
    const h = harness({ pickRegion: () => Promise.reject(new Error('no frame')) });
    await h.manager.configure({ ...CONFIG, captureMode: 'region' });
    expect(await h.manager.record()).toEqual({ status: 'cancelled' });
    expect(h.notices.at(-1)).toMatchObject({ level: 'error' });
    expect(h.notices.at(-1)?.message).toContain('no frame');
  });

  it('reports its current state through status()', async () => {
    const h = harness();
    expect(h.manager.status()).toMatchObject({ state: 'idle', sessionId: null });
    await startRecording(h);
    h.clock.us = 3 * S;
    expect(h.manager.status()).toMatchObject({ state: 'recording', elapsedUs: 3 * S });
    await h.manager.abort();
    expect(h.manager.status().state).toBe('aborted');
  });

  it('forwards mic and system levels only while capturing (R1.12)', async () => {
    const h = harness();
    h.manager.onEngineLevels({ atUs: T0, mic: 0.9 });
    expect(h.levels).toEqual([]);
    await startRecording(h);
    h.manager.onEngineLevels({ atUs: T0 + S, mic: 0.25 });
    const captureId = h.utility.system?.captureId ?? '';
    h.utility.emit({ type: 'system.level', captureId, peak: 0.5 });
    // The setup panel's monitor (null id) and other captures are not this session's.
    h.utility.emit({ type: 'system.level', captureId: null, peak: 0.7 });
    h.utility.emit({ type: 'system.level', captureId: 'other', peak: 0.7 });
    expect(h.levels).toEqual([{ mic: 0.25 }, { system: 0.5 }]);
    await h.manager.pause();
    h.manager.onEngineLevels({ atUs: T0 + 2 * S, mic: 0 });
    expect(h.levels.at(-1)).toEqual({ mic: 0 });
    await h.manager.abort();
    h.manager.onEngineLevels({ atUs: T0 + 3 * S, mic: 0.3 });
    expect(h.levels).toHaveLength(3);
  });

  it("uses the engine's dropped-frame accounting when it sends one (§9.3)", async () => {
    const h = harness();
    await startRecording(h);
    h.manager.onEngineStats({
      atUs: T0 + S,
      streams: [
        {
          kind: 'camera',
          framesIn: 17,
          framesEncoded: 17,
          framesDropped: 0,
          bytes: 10,
          discontinuities: 0,
          queueDepth: 0,
          droppedRatio: 0.03,
        },
      ],
    });
    expect(h.stats.at(-1)?.dropped).toEqual({ screen: 0, camera: 0.03 });
    await h.manager.abort();
  });

  it('forwards engine stats as rec.stats', async () => {
    const h = harness();
    await startRecording(h);
    h.clock.us = 2 * S;
    h.manager.onEngineStats({
      atUs: T0 + 2 * S,
      streams: [
        {
          kind: 'screen',
          framesIn: 100,
          framesEncoded: 98,
          framesDropped: 2,
          bytes: 1000,
          discontinuities: 0,
          queueDepth: 1,
        },
        {
          kind: 'mic',
          framesIn: 90,
          framesEncoded: 90,
          framesDropped: 0,
          bytes: 50,
          discontinuities: 0,
          queueDepth: 0,
          level: 0.4,
        },
      ],
    });
    expect(h.stats.at(-1)).toEqual({
      elapsedUs: 2 * S,
      levels: { mic: 0.4, system: null },
      dropped: { screen: 0.02, camera: 0 },
      bytesWritten: 1050,
    });
    await h.manager.abort();
  });

  it('follows the action bus (CLI, tray)', async () => {
    const h = harness();
    const bus = new ActionBus();
    h.manager.attach(bus);
    bus.dispatch({ type: 'toggle-recording', source: 'cli' });
    await waitFor(() => h.manager.state === 'recording');
    await waitFor(() => h.engine.count('engine.start') === 1 && h.manager.activeRoot !== null);
    bus.dispatch({ type: 'toggle-pause', source: 'tray' });
    await waitFor(() => h.manager.state === 'paused');
    bus.dispatch({ type: 'resume-recording', source: 'cli' });
    await waitFor(() => h.manager.state === 'recording');
    bus.dispatch({ type: 'stop-recording', source: 'tray' });
    await waitFor(() => h.manager.state === 'completed');
    await h.manager.settled();
    expect(h.ready).toHaveLength(1);
  });

  it('restarts on the restart-recording action (tray, after confirmation)', async () => {
    const h = harness();
    const bus = new ActionBus();
    h.manager.attach(bus);
    await startRecording(h);
    bus.dispatch({ type: 'restart-recording', source: 'tray' });
    await waitFor(() => h.engine.count('engine.start') === 2 && h.manager.state === 'recording');
    await h.manager.abort();
  });

  it('writes drift checkpoints from engine.stats to sync.json while recording', async () => {
    const h = harness();
    const root = await startRecording(h);
    const stats = (checkpoints: [number, number][]) =>
      h.manager.onEngineStats({
        atUs: T0,
        streams: [
          {
            kind: 'mic',
            framesIn: 1,
            framesEncoded: 1,
            framesDropped: 0,
            bytes: 1,
            discontinuities: 0,
            queueDepth: 0,
            nominalRate: 48_000,
            checkpoints,
          },
        ],
      });
    stats([[1 * S, 48_000]]);
    stats([[2 * S, 96_000]]);
    const file = path.join(root, 'media', 'mic.sync.json');
    await waitFor(() => h.utility.opened.length > 0);
    await expect
      .poll(async () => JSON.parse(await fs.readFile(file, 'utf8').catch(() => 'null')) as unknown)
      .toEqual({
        version: 1,
        nominalRate: 48_000,
        checkpoints: [
          [1 * S, 48_000],
          [2 * S, 96_000],
        ],
      });
    await h.manager.abort();
  });

  it("prefers the engine's pause list and stop time", async () => {
    const h = harness();
    const root = await startRecording(h);
    h.engine.stopExtra = {
      t0Us: T0,
      stoppedAtUs: T0 + 30 * S,
      pauses: [{ startUs: T0 + 2 * S, endUs: T0 + 3 * S }],
    };
    h.utility.durations = { screen: 1 * S, camera: 1 * S, mic: 1 * S, system: 1 * S };
    await h.manager.stop();
    const doc = await readProject(root);
    expect(doc.recording?.pauses).toEqual([{ startUs: 2 * S, endUs: 3 * S }]);
  });
});
