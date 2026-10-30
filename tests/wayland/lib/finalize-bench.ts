/**
 * R1.20 benchmark: how long finalizing a recording of `minutes` takes, on a synthetic recording
 * shaped like the recorder's output (`media/<kind>.rec.mp4` fragmented MP4 with ≤1 s fragments:
 * 1440p30 H.264 screen at ~6 Mbit/s, 720p camera, Opus mic and system audio, mic and system
 * drift checkpoints every second). It runs what main runs after Stop, through the real media
 * utility service: the finalize job (remux, probe, sync files), the drift fits, then peaks and
 * thumbnails (`generateCaches`).
 *
 * The recording is built from a 10 s encoded seed looped with `-c copy`, so a 10-minute fixture
 * takes seconds to make. Keep `workDir` on the same disk as real projects (not a tmpfs) for a
 * realistic I/O figure.
 */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fitDrift, generateCaches, type JobRunner } from '../../../src/main/recording/assemble';
import type { StreamKind } from '../../../src/shared/ipc/contract';
import {
  JOB_RESULT_SCHEMAS,
  type JobKind,
  type JobResult,
  type JobSpec,
  type MediaUtilityEvent,
} from '../../../src/shared/ipc/media-utility';
import type { Media } from '../../../src/shared/project/schema';
import { MediaService } from '../../../src/utility/media/service';

export interface BenchOptions {
  ffmpeg: string;
  ffprobe: string;
  minutes: number;
  /** A folder for the fixture project (created; removed by the caller). */
  workDir: string;
  /** Screen size (default 2560×1440, the Phase 1 target, §8 Q5). */
  screen?: { width: number; height: number };
}

export interface BenchResult {
  minutes: number;
  bytes: number;
  fixtureMs: number;
  finalizeMs: number;
  driftMs: number;
  cachesMs: number;
  /** Stop → project ready, without the engine's own stop (≤ 10 s for 10 minutes, R1.20). */
  totalMs: number;
  /** Each cache job (`peaks <kind>`, `thumbnails <kind>`), ms. */
  jobs: Record<string, number>;
  streams: { kind: StreamKind; ok: boolean; durationUs: number | null; error: string | null }[];
}

const SEED_S = 10;
const FRAGMENTED = [
  '-movflags',
  '+frag_keyframe+empty_moov+default_base_moof',
  '-frag_duration',
  '1000000',
  '-f',
  'mp4',
];

const KINDS: { kind: StreamKind; video: boolean }[] = [
  { kind: 'screen', video: true },
  { kind: 'camera', video: true },
  { kind: 'mic', video: false },
  { kind: 'system', video: false },
];

function seedArgs(kind: StreamKind, screen: { width: number; height: number }): string[] {
  const d = String(SEED_S);
  switch (kind) {
    case 'screen':
      return [
        '-f',
        'lavfi',
        '-i',
        `testsrc2=size=${String(screen.width)}x${String(screen.height)}:rate=30:duration=${d}`,
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-b:v',
        '6M',
        '-g',
        '30',
        '-pix_fmt',
        'yuv420p',
      ];
    case 'camera':
      return [
        '-f',
        'lavfi',
        '-i',
        `testsrc=size=1280x720:rate=30:duration=${d}`,
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-b:v',
        '2500k',
        '-g',
        '30',
        '-pix_fmt',
        'yuv420p',
      ];
    case 'mic':
      return [
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=440:sample_rate=48000:duration=${d}`,
        '-c:a',
        'libopus',
        '-b:a',
        '64k',
      ];
    case 'system':
      return [
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=1000:sample_rate=48000:duration=${d}`,
        '-ac',
        '2',
        '-c:a',
        'libopus',
        '-b:a',
        '128k',
      ];
  }
}

/** Writes `media/<kind>.rec.mp4` (and sync files) for a `minutes`-long recording. */
export async function makeRecordingFixture(options: BenchOptions): Promise<string> {
  const media = path.join(options.workDir, 'Bench.cstudio', 'media');
  await fs.mkdir(media, { recursive: true });
  const screen = options.screen ?? { width: 2560, height: 1440 };
  const loops = Math.max(0, Math.ceil((options.minutes * 60) / SEED_S) - 1);
  const ff = (args: string[]) =>
    execFileSync(options.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  for (const { kind } of KINDS) {
    const seed = path.join(options.workDir, `${kind}.seed.mp4`);
    ff([...seedArgs(kind, screen), seed]);
    ff([
      '-stream_loop',
      String(loops),
      '-i',
      seed,
      '-t',
      String(options.minutes * 60),
      '-c',
      'copy',
      ...FRAGMENTED,
      path.join(media, `${kind}.rec.mp4`),
    ]);
    await fs.rm(seed);
  }
  // Drift checkpoints every second, +40 ppm (mic) and −25 ppm (system).
  for (const [kind, ppm] of [
    ['mic', 40],
    ['system', -25],
  ] as const) {
    const checkpoints: [number, number][] = [];
    for (let s = 1; s <= options.minutes * 60; s++) {
      checkpoints.push([s * 1_000_000, Math.round(s * 48_000 * (1 + ppm / 1e6))]);
    }
    await fs.writeFile(
      path.join(media, `${kind}.sync.json`),
      JSON.stringify({ version: 1, nominalRate: 48_000, checkpoints }),
    );
  }
  return path.dirname(media);
}

/** `runJob` over an in-process media utility service. */
function serviceRunner(service: MediaService, events: Set<(e: MediaUtilityEvent) => void>) {
  let next = 0;
  const runner: JobRunner = {
    runJob<K extends JobKind>(job: Extract<JobSpec, { kind: K }>): Promise<JobResult<K>> {
      const jobId = `bench-${String(++next)}`;
      return new Promise((resolve, reject) => {
        const listener = (e: MediaUtilityEvent) => {
          if (e.type === 'job.done' && e.jobId === jobId) {
            events.delete(listener);
            resolve(JOB_RESULT_SCHEMAS[job.kind].parse(e.result) as JobResult<K>);
          } else if (e.type === 'job.error' && e.jobId === jobId) {
            events.delete(listener);
            reject(new Error(e.message));
          }
        };
        events.add(listener);
        void service.handle({ type: 'job', jobId, job });
      });
    },
  };
  return runner;
}

async function folderBytes(dir: string): Promise<number> {
  let total = 0;
  for (const name of await fs.readdir(dir)) total += (await fs.stat(path.join(dir, name))).size;
  return total;
}

export async function benchFinalize(options: BenchOptions): Promise<BenchResult> {
  const fixtureStart = performance.now();
  const root = await makeRecordingFixture(options);
  const fixtureMs = performance.now() - fixtureStart;
  const mediaDir = path.join(root, 'media');
  const bytes = await folderBytes(mediaDir);

  const listeners = new Set<(e: MediaUtilityEvent) => void>();
  const service = new MediaService({ emit: (e) => listeners.forEach((l) => l(e)) });
  try {
    await service.handle({
      type: 'init',
      ffmpegPath: options.ffmpeg,
      ffprobePath: options.ffprobe,
    });
    const service_ = serviceRunner(service, listeners);
    const jobs: Record<string, number> = {};
    // Times each cache job, named by its kind and stream.
    const runner: JobRunner = {
      async runJob(job) {
        const start = performance.now();
        try {
          return await service_.runJob(job);
        } finally {
          const input = 'input' in job ? path.basename(job.input, '.mp4') : '';
          jobs[`${job.kind}${input ? ` ${input}` : ''}`] = Math.round(performance.now() - start);
        }
      },
    };

    const t0 = performance.now();
    const finalized = await runner.runJob({
      kind: 'finalize',
      dir: mediaDir,
      streams: KINDS.map(({ kind, video }) => ({
        kind,
        expect: video ? { video: 1, audio: 0 } : { video: 0, audio: 1 },
      })),
      recovering: false,
    });
    const t1 = performance.now();
    for (const s of finalized.streams) fitDrift(s.sync ?? null);
    const t2 = performance.now();
    const media = finalized.streams
      .filter((s) => s.ok)
      .map(
        (s) =>
          ({
            id: `bench-${s.kind}`,
            kind: KINDS.find((k) => k.kind === s.kind)?.video ? 'video' : 'audio',
            path: `media/${s.kind}.mp4`,
            status: 'ok',
            durationUs: s.durationUs ?? 0,
          }) as unknown as Media,
      );
    await generateCaches(runner, root, media, {
      info: () => undefined,
      warn: (...p: unknown[]) => console.warn(...p),
      error: (...p: unknown[]) => console.error(...p),
    });
    const t3 = performance.now();
    return {
      minutes: options.minutes,
      bytes,
      fixtureMs: Math.round(fixtureMs),
      finalizeMs: Math.round(t1 - t0),
      driftMs: Math.round(t2 - t1),
      cachesMs: Math.round(t3 - t2),
      totalMs: Math.round(t3 - t0),
      jobs,
      streams: finalized.streams.map((s) => ({
        kind: s.kind,
        ok: s.ok,
        durationUs: s.durationUs ?? null,
        error: s.error ?? null,
      })),
    };
  } finally {
    await service.shutdown();
  }
}
