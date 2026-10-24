/**
 * Recovery (§4.3.6, R1.21) against the real bundled FFmpeg: interrupted recordings with
 * truncated fragmented MP4 files (generated with lavfi) are found by their stale lock, remuxed,
 * probed and rebuilt into a `recovered` project. Needs `npm run fetch:ffmpeg` first.
 */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { locateFfmpeg, type FfmpegLocation } from '../../src/main/ffmpeg/locate';
import { ProjectRootRegistry } from '../../src/main/projects/media-protocol';
import { ProjectStore } from '../../src/main/projects/project-store';
import {
  readLock,
  writeLock,
  writeSessionLog,
  type JobRunner,
  type SessionLog,
} from '../../src/main/recording/assemble';
import { RecoveryService } from '../../src/main/recording/recovery';
import type { JobKind, JobResult, JobSpec } from '../../src/shared/ipc/media-utility';
import {
  projectFromRecording,
  type RecordingManifest,
} from '../../src/shared/project/from-recording';
import { ProjectV1Schema, type ProjectV1 } from '../../src/shared/project/schema';
import { unwrap } from '../../src/shared/result';
import { finalizeRecording } from '../../src/utility/media/finalize';
import { generatePeaks } from '../../src/utility/media/peaks';
import { generateThumbnails } from '../../src/utility/media/thumbnails';

const ROOT = path.join(import.meta.dirname, '../..');
const T0 = 1_761_300_000_000_000;
const OFFSET = 1_500;
const S = 1_000_000;
const DEAD_PID = 2_147_000_000;

let ffmpeg: FfmpegLocation;
let work: string;
let projectsDir: string;

beforeAll(async () => {
  const located = await locateFfmpeg({ isPackaged: false, resourcesPath: '', appPath: ROOT });
  if (!located.ok) throw located.error;
  ffmpeg = located.value;
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-recovery-'));
});

afterAll(async () => {
  if (work) await fs.rm(work, { recursive: true, force: true });
});

let caseNo = 0;
beforeEach(async () => {
  caseNo += 1;
  projectsDir = path.join(work, `Projects-${String(caseNo)}`);
  await fs.mkdir(projectsDir, { recursive: true });
});

function ff(args: string[]): void {
  execFileSync(ffmpeg.ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const FRAGMENTED = [
  '-movflags',
  '+frag_keyframe+empty_moov+default_base_moof',
  '-frag_duration',
  '1000000',
  '-f',
  'mp4',
];

function makeVideoRec(file: string, seconds: number, size = '640x360'): void {
  ff([
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${size}:rate=30:duration=${String(seconds)}`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-g',
    '30',
    '-pix_fmt',
    'yuv420p',
    ...FRAGMENTED,
    '-y',
    file,
  ]);
}

function makeAudioRec(file: string, seconds: number, channels = 2): void {
  ff([
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=1000:sample_rate=48000:duration=${String(seconds)}`,
    '-ac',
    String(channels),
    '-c:a',
    'libopus',
    '-b:a',
    '96k',
    ...FRAGMENTED,
    '-y',
    file,
  ]);
}

/** Simulates a kill: cut the file at `fraction` of its bytes (mid-fragment). */
async function truncate(file: string, fraction: number): Promise<void> {
  const { size } = await fs.stat(file);
  await fs.truncate(file, Math.floor(size * fraction));
}

/** Runs utility jobs in-process with the real FFmpeg (what the media utility does). */
function jobRunner(): JobRunner & { jobs: JobSpec[] } {
  const jobs: JobSpec[] = [];
  return {
    jobs,
    async runJob<K extends JobKind>(spec: Extract<JobSpec, { kind: K }>): Promise<JobResult<K>> {
      const job: JobSpec = spec;
      jobs.push(job);
      switch (job.kind) {
        case 'finalize':
          return {
            streams: await finalizeRecording({
              ffmpegPath: ffmpeg.ffmpeg,
              ffprobePath: ffmpeg.ffprobe,
              dir: job.dir,
              streams: job.streams,
              recovering: job.recovering,
            }),
          } as JobResult<K>;
        case 'peaks':
          return (await generatePeaks({
            ffmpegPath: ffmpeg.ffmpeg,
            input: job.input,
            output: job.output,
          })) as JobResult<K>;
        case 'thumbnails':
          return (await generateThumbnails({
            ffmpegPath: ffmpeg.ffmpeg,
            ffprobePath: ffmpeg.ffprobe,
            input: job.input,
            outDir: job.outDir,
            mediaId: job.mediaId,
          })) as JobResult<K>;
        default:
          throw new Error(`unexpected job ${job.kind}`);
      }
    },
  };
}

const PLATFORM = { os: 'linux' as const, electron: '45.0.0', chromium: '156', ffmpeg: 'n9.0.2' };

function manifest(id: string, name: string): RecordingManifest {
  return {
    version: 1,
    projectId: id,
    name,
    createdAt: '2026-10-24T14:05:00.000Z',
    appVersion: '0.1.0',
    recording: {
      state: 'recording',
      sessionId: 'ses_01JBQ4ZJ4Y0000000000000000',
      startedAt: '2026-10-24T14:05:03.000Z',
      durationUs: 6 * S,
      pauses: [{ startUs: 1 * S, endUs: 2 * S }],
      source: { kind: 'monitor', widthPx: 640, heightPx: 360, region: null },
      platform: PLATFORM,
    },
    frameRate: 30,
    streams: [],
  };
}

interface Fixture {
  id: string;
  root: string;
  store: ProjectStore;
}

/** A project folder as a killed recording leaves it. */
async function interrupted(
  name: string,
  options: { log?: boolean; lock?: 'dead' | 'fresh-own' | 'stale-remote' | 'none' } = {},
): Promise<Fixture> {
  const id = `prj_REC${String(caseNo)}${name.replace(/\W/g, '')}`;
  const root = path.join(projectsDir, `${name}.cstudio`);
  const media = path.join(root, 'media');
  await fs.mkdir(media, { recursive: true });
  const store = new ProjectStore({ registry: new ProjectRootRegistry() });
  const base = manifest(id, name);
  await store.write(root, unwrap(projectFromRecording(base)));

  makeVideoRec(path.join(media, 'screen.rec.mp4'), 10);
  makeAudioRec(path.join(media, 'mic.rec.mp4'), 10, 1);
  makeAudioRec(path.join(media, 'system.rec.mp4'), 10);
  await truncate(path.join(media, 'screen.rec.mp4'), 0.6);
  await truncate(path.join(media, 'mic.rec.mp4'), 0.55);
  // System audio checkpoints on the utility clock, 48 kHz exactly.
  await fs.writeFile(
    path.join(media, 'system.sync.json'),
    JSON.stringify({
      version: 1,
      nominalRate: 48_000,
      checkpoints: Array.from({ length: 6 }, (_, i) => [T0 + OFFSET + 20_000 + i * S, i * 48_000]),
    }),
  );

  if (options.log ?? true) {
    const stream = (kind: 'screen' | 'mic' | 'system', startOffsetUs: number) => ({
      kind,
      streamId: `${kind}-1`,
      mediaId: `med_${kind.toUpperCase()}${String(caseNo)}`,
      label: kind === 'mic' ? 'Built-in Mic' : null,
      encoder: { name: kind === 'screen' ? 'H.264 (software)' : 'Opus', hardware: false },
      sync: {
        mode: kind === 'screen' ? ('shared' as const) : ('arrival-calibrated' as const),
        offsetUs: 0,
        clockHandshakeUs: kind === 'system' ? OFFSET : null,
      },
      startOffsetUs,
      endedEarly: false,
      endedAtUs: null,
      stats: { framesEncoded: 180, framesDropped: 0 },
    });
    const log: SessionLog = {
      version: 1,
      updatedAt: '2026-10-24T14:05:09.000Z',
      t0Us: T0,
      utilityClockOffsetUs: OFFSET,
      systemCaptureId: 'system-1',
      streams: [stream('screen', 0), stream('mic', 12_800), stream('system', 20_000)],
      notices: [],
      manifest: base,
    };
    await writeSessionLog(root, log);
  }

  const lock = options.lock ?? 'dead';
  if (lock !== 'none') {
    await writeLock(root, {
      pid: lock === 'dead' ? DEAD_PID : process.pid,
      hostname: lock === 'stale-remote' ? 'another-machine' : os.hostname(),
      heartbeatAt: lock === 'fresh-own' ? new Date().toISOString() : '2026-01-01T00:00:00.000Z',
      appVersion: '0.1.0',
    });
  }
  return { id, root, store };
}

function service(store: ProjectStore, runner = jobRunner()) {
  const trashed: string[] = [];
  const recovery = new RecoveryService({
    store,
    utility: runner,
    projectsDir: () => projectsDir,
    trashItem: (p) => {
      trashed.push(p);
      return fs.rm(p, { recursive: true });
    },
    appVersion: '0.1.0',
    platform: () => PLATFORM,
    isAlive: (pid) => pid === process.pid,
  });
  return { recovery, trashed, runner };
}

async function readProject(root: string): Promise<ProjectV1> {
  return ProjectV1Schema.parse(
    JSON.parse(await fs.readFile(path.join(root, 'project.json'), 'utf8')),
  );
}

describe('recovery (§4.3.6, R1.21)', () => {
  it('lists only interrupted recordings whose lock is stale', async () => {
    const dead = await interrupted('Dead pid');
    await interrupted('Still running', { lock: 'fresh-own' });
    const remote = await interrupted('Remote stale', { lock: 'stale-remote' });
    const nolock = await interrupted('No lock', { lock: 'none' });
    // A complete project is never offered.
    const complete = await interrupted('Complete', { lock: 'none' });
    await complete.store.update(complete.id, (d) => ({
      ...d,
      recording: d.recording ? { ...d.recording, state: 'complete' } : null,
    }));

    const { recovery } = service(dead.store);
    const ids = (await recovery.list()).map((c) => c.id).sort();
    expect(ids).toEqual([dead.id, nolock.id, remote.id].sort());
    const candidate = (await recovery.list()).find((c) => c.id === dead.id);
    expect(candidate).toMatchObject({
      name: 'Dead pid',
      state: 'recording',
      startedAt: '2026-10-24T14:05:03.000Z',
    });
    expect(candidate?.sizeBytes).toBeGreaterThan(0);
  });

  it('recovers truncated streams into a "recovered" project', async () => {
    const { id, root, store } = await interrupted('Crashed lesson');
    const { recovery, runner } = service(store);
    expect((await recovery.list()).map((c) => c.id)).toEqual([id]);

    expect(await recovery.recover(id)).toEqual({ projectId: id });

    const doc = await readProject(root);
    expect(doc.recording?.state).toBe('recovered');
    expect(doc.recording?.clockMode).toBe('hybrid');
    expect(doc.media.map((m) => [m.role, m.status, m.path])).toEqual([
      ['screen', 'recovered', 'media/screen.mp4'],
      ['microphone', 'recovered', 'media/mic.mp4'],
      ['system-audio', 'recovered', 'media/system.mp4'],
    ]);
    const [screen, mic, system] = doc.media;
    // Durations come from the probed, remuxed files: the truncated ones lost their tails.
    expect(screen!.durationUs).toBeGreaterThan(3 * S);
    expect(screen!.durationUs).toBeLessThan(9.5 * S);
    expect(mic!.durationUs).toBeLessThan(9.5 * S);
    expect(system!.durationUs).toBeGreaterThan(9.5 * S);
    expect(mic!.startOffsetUs).toBe(12_800);
    expect(mic!.device).toEqual({ label: 'Built-in Mic' });
    expect(system!.startOffsetUs).toBe(20_000);
    expect(system!.audio?.syncCheckpointsPath).toBe('media/system.sync.json');
    expect(system!.clockRatio).toBe(1);
    // Session length from the longest stream; the pause is left out of the timeline.
    expect(doc.recording?.durationUs).toBe(system!.startOffsetUs + system!.durationUs);
    const screenClips = doc.timeline.tracks.find((t) => t.name === 'Screen')!.clips;
    expect(screenClips.map((c) => c.sourceStartUs)).toEqual([0, 2 * S]);
    expect(screenClips[1]!.timelineStartUs).toBe(1 * S);

    // .rec files are gone, final files and caches exist, the lock is removed.
    const files = await fs.readdir(path.join(root, 'media'));
    expect(files.filter((f) => f.endsWith('.rec.mp4'))).toEqual([]);
    expect(files).toEqual(expect.arrayContaining(['screen.mp4', 'mic.mp4', 'system.mp4']));
    const cache = await fs.readdir(path.join(root, 'cache'));
    expect(cache).toEqual(
      expect.arrayContaining([
        `${screen!.id}.thumbs.json`,
        `${mic!.id}.peaks`,
        `${system!.id}.peaks`,
      ]),
    );
    expect(await readLock(root)).toBeNull();
    expect(runner.jobs[0]).toMatchObject({ kind: 'finalize', recovering: true });
    // It is no longer a candidate.
    expect(await recovery.list()).toEqual([]);
  });

  it('recovers from the files alone when the session log is missing', async () => {
    const { id, root, store } = await interrupted('No log', { log: false });
    const { recovery } = service(store);
    await recovery.recover(id);
    const doc = await readProject(root);
    expect(doc.recording?.state).toBe('recovered');
    expect(doc.media.map((m) => m.role).sort()).toEqual(['microphone', 'screen', 'system-audio']);
    expect(doc.timeline.tracks.find((t) => t.name === 'Screen')!.clips.length).toBeGreaterThan(0);
  });

  it('discards by moving to the trash, or leaves the folder alone', async () => {
    const a = await interrupted('Trash me');
    const b = await interrupted('Leave me');
    const { recovery, trashed } = service(a.store);
    await recovery.list();
    await recovery.discard(a.id, 'trash');
    expect(trashed).toEqual([a.root]);
    await recovery.discard(b.id, 'leave');
    expect(await recovery.list()).toEqual([]);
    // Left alone: still on disk, still offered after a restart (a new service).
    expect(await fs.stat(b.root)).toBeTruthy();
    expect((await service(b.store).recovery.list()).map((c) => c.id)).toEqual([b.id]);
  });
});
