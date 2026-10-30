/**
 * Main-side export handlers (§4.3.11, step 19): target and file-exists policy (R1.47), offline
 * media (R1.29), the snapshot sent to the utility (R1.49), Auto vs Software encoder, progress
 * with ETA, done/error events, cancel, reveal/open after completion.
 */
import { existsSync, promises as fs, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FfmpegEncoderReport } from '../../src/shared/capabilities/types';
import { exportTempName, exportTempOwner } from '../../src/shared/export/temp-name';
import type { EventChannel, EventPayload, ExportOptions } from '../../src/shared/ipc/contract';
import type { JobResult } from '../../src/shared/ipc/media-utility';
import { silentLogger } from '../../src/shared/logger';
import type { ProjectV1 } from '../../src/shared/project/schema';
import { createDefaultSettings } from '../../src/shared/settings/schema';
import {
  estimateEtaSec,
  ExportService,
  exportFileName,
  offlineExportMedia,
  sweepStaleExportTemps,
  withMp4Extension,
  type ExportHandlerDeps,
} from '../../src/main/ipc/export-handlers';
import type { RunJobOptions } from '../../src/main/utility-host';
import { recordedProject } from '../fixtures/editor-project';

const OPTIONS: ExportOptions = {
  resolution: 'canvas',
  fps: 'project',
  quality: 'standard',
  encoder: 'auto',
};

type Job = Parameters<ExportHandlerDeps['runExport']>[0];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(overrides: Partial<ExportHandlerDeps> = {}) {
  const doc = recordedProject();
  const events: { channel: EventChannel; payload: unknown }[] = [];
  const handlers = new Map<string, (payload: unknown, context: { senderId: number }) => unknown>();
  const files = new Set<string>();
  const jobs: {
    job: Job;
    options: RunJobOptions;
    result: ReturnType<typeof deferred<JobResult<'export'>>>;
  }[] = [];
  let clock = 0;
  const report: FfmpegEncoderReport = {
    probedAt: '2026-10-24T00:00:00.000Z',
    encoders: [],
    hardware: 'h264_vaapi',
    software: 'libx264',
  };
  const deps: ExportHandlerDeps = {
    router: {
      handle: ((
        channel: string,
        handler: (payload: unknown, context: { senderId: number }) => unknown,
      ) => {
        handlers.set(channel, handler);
      }) as ExportHandlerDeps['router']['handle'],
      broadcast: <C extends EventChannel>(channel: C, payload: EventPayload<C>) => {
        events.push({ channel, payload });
        return 1;
      },
    },
    runExport: (job, options) => {
      const result = deferred<JobResult<'export'>>();
      jobs.push({ job, options, result });
      return result.promise;
    },
    findRoot: (id) => Promise.resolve(id === doc.id ? '/projects/Lesson.cstudio' : null),
    readProject: () => Promise.resolve(doc),
    settings: () =>
      createDefaultSettings({ projectsDir: '/videos/CS', exportsDir: '/videos/CS/Exports' }),
    probeEncoders: () => Promise.resolve(report),
    showSaveDialog: vi.fn(() => Promise.resolve<string | null>('/elsewhere/Chosen')),
    showItemInFolder: vi.fn(),
    openPath: vi.fn(() => Promise.resolve('')),
    logger: silentLogger,
    fileExists: (file) => Promise.resolve(files.has(file)),
    now: () => clock,
    ...overrides,
  };
  const service = new ExportService(deps);
  service.register();
  const call = async <T>(channel: string, payload: unknown): Promise<T> =>
    (await handlers.get(channel)?.(payload, { senderId: 7 })) as T;
  return {
    doc,
    deps,
    service,
    events,
    files,
    jobs,
    call,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('export handlers', () => {
  it('targets <exportsDir>/<project name>.mp4 by default', async () => {
    const { doc, call } = setup();
    expect(await call('export.target', { projectId: doc.id })).toEqual({
      path: '/videos/CS/Exports/Lesson test.mp4',
      exists: false,
    });
  });

  it('asks before replacing an existing file (R1.47)', async () => {
    const { doc, call, files, jobs } = setup();
    files.add('/videos/CS/Exports/Lesson test.mp4');
    const first = await call('export.start', { projectId: doc.id, options: OPTIONS });
    expect(first).toMatchObject({ jobId: null, status: 'exists' });
    expect(jobs).toHaveLength(0);
    const second = await call<{ jobId: string; status: string }>('export.start', {
      projectId: doc.id,
      options: OPTIONS,
      overwrite: true,
    });
    expect(second.status).toBe('started');
    expect(jobs[0]?.job.overwrite).toBe(true);
  });

  it('uses the save dialog choice, adds .mp4, and trusts its overwrite confirmation', async () => {
    const { doc, call, files, jobs, deps } = setup({
      showSaveDialog: vi.fn(() => Promise.resolve<string | null>('/elsewhere/Talk.mp4')),
    });
    files.add('/elsewhere/Talk.mp4');
    expect(await call('export.chooseOutput', { projectId: doc.id })).toEqual({
      path: '/elsewhere/Talk.mp4',
      exists: true,
    });
    expect(deps.showSaveDialog).toHaveBeenCalledWith({
      defaultPath: '/videos/CS/Exports/Lesson test.mp4',
      senderId: 7,
    });
    const started = await call<{ status: string; path: string }>('export.start', {
      projectId: doc.id,
      options: OPTIONS,
    });
    expect(started).toMatchObject({ status: 'started', path: '/elsewhere/Talk.mp4' });
    expect(jobs[0]?.job).toMatchObject({ output: '/elsewhere/Talk.mp4', overwrite: true });
    expect(withMp4Extension('/a/b')).toBe('/a/b.mp4');
    expect(withMp4Extension('/a/b.MP4')).toBe('/a/b.MP4');
  });

  it('blocks with a clear message when a media file broke after the editor opened (R1.29)', async () => {
    const { doc, call, jobs } = setup({
      // The editor's snapshot still says ok; the file on disk is now damaged.
      checkMedia: (_root, d) =>
        Promise.resolve({
          ...d,
          media: d.media.map((m) => (m.role === 'screen' ? { ...m, status: 'missing' } : m)),
        }),
    });
    const result = await call<{ status: string; message: string }>('export.start', {
      projectId: doc.id,
      options: OPTIONS,
      doc,
    });
    expect(result.status).toBe('blocked');
    expect(result.message).toMatch(/missing or unreadable: media\/screen\.mp4/);
    expect(jobs).toHaveLength(0);
  });

  it('keeps the target when the dialog is cancelled', async () => {
    const { doc, call } = setup({ showSaveDialog: () => Promise.resolve(null) });
    expect(await call('export.chooseOutput', { projectId: doc.id })).toBeNull();
    expect(await call('export.target', { projectId: doc.id })).toMatchObject({
      path: '/videos/CS/Exports/Lesson test.mp4',
    });
  });

  it('exports the snapshot it was given and picks the encoder from the probe', async () => {
    const { doc, call, jobs } = setup();
    const snapshot: ProjectV1 = { ...doc, name: 'Edited' };
    await call('export.start', { projectId: doc.id, options: OPTIONS, doc: snapshot });
    expect(jobs[0]?.job.doc).toBe(snapshot);
    expect(jobs[0]?.job.root).toBe('/projects/Lesson.cstudio');
    expect(jobs[0]?.job.hardwareEncoder).toBe('h264_vaapi');
    const again = await call('export.start', {
      projectId: doc.id,
      options: { ...OPTIONS, encoder: 'software' },
      doc: snapshot,
      overwrite: true,
    });
    // Same target while the first runs: blocked.
    expect(again).toMatchObject({ status: 'blocked', path: '/videos/CS/Exports/Edited.mp4' });
    expect(jobs).toHaveLength(1);
  });

  it('uses Software when Auto has no verified hardware encoder', async () => {
    const { doc, call, jobs } = setup({ probeEncoders: () => Promise.reject(new Error('no')) });
    await call('export.start', { projectId: doc.id, options: OPTIONS });
    expect(jobs[0]?.job.hardwareEncoder).toBeNull();
  });

  it('rejects a document of another project', async () => {
    const { doc, call } = setup();
    await expect(
      call('export.start', {
        projectId: doc.id,
        options: OPTIONS,
        doc: { ...doc, id: 'prj_OTHER' },
      }),
    ).rejects.toThrow(/does not belong/);
  });

  it('blocks offline media with a clear message (R1.29)', async () => {
    const { doc, call, jobs } = setup();
    const snapshot = structuredClone(doc);
    const camera = snapshot.media.find((m) => m.role === 'camera');
    if (camera) camera.status = 'missing';
    expect(offlineExportMedia(snapshot)).toEqual(['media/camera.mp4']);
    const result = await call<{ status: string; message: string }>('export.start', {
      projectId: doc.id,
      options: OPTIONS,
      doc: snapshot,
    });
    expect(result.status).toBe('blocked');
    expect(result.message).toContain('media/camera.mp4');
    expect(jobs).toHaveLength(0);
  });

  it('reports progress with an ETA, then done with the fallback notice; reveal and open work after', async () => {
    const { doc, call, jobs, events, tick, deps } = setup();
    const { jobId } = await call<{ jobId: string }>('export.start', {
      projectId: doc.id,
      options: OPTIONS,
    });
    await expect(call('export.reveal', { jobId })).rejects.toThrow(/not finished/);
    const job = jobs[0];
    tick(10_000);
    job?.options.onProgress?.(0.25);
    expect(events.at(-1)).toEqual({
      channel: 'export.progress',
      payload: { jobId, fraction: 0.25, etaSec: 30 },
    });
    job?.result.resolve({
      output: '/videos/CS/Exports/Lesson test.mp4',
      encoder: 'libx264',
      fallback: { from: 'h264_vaapi', reason: 'boom' },
      durationUs: 1,
      sizeBytes: 1,
      elapsedMs: 1,
    });
    await flush();
    expect(events.at(-1)).toMatchObject({
      channel: 'export.done',
      payload: {
        jobId,
        outputName: 'Lesson test.mp4',
        encoder: 'libx264',
        notice: expect.stringContaining('h264_vaapi') as unknown,
      },
    });
    await call('export.reveal', { jobId });
    expect(deps.showItemInFolder).toHaveBeenCalledWith('/videos/CS/Exports/Lesson test.mp4');
    await call('export.open', { jobId });
    expect(deps.openPath).toHaveBeenCalledWith('/videos/CS/Exports/Lesson test.mp4');
  });

  it('cancels through the job signal and reports a cancelled error', async () => {
    const { doc, call, jobs, events } = setup();
    const { jobId } = await call<{ jobId: string }>('export.start', {
      projectId: doc.id,
      options: OPTIONS,
    });
    const job = jobs[0];
    expect(job?.options.signal?.aborted).toBe(false);
    await call('export.cancel', { jobId });
    expect(job?.options.signal?.aborted).toBe(true);
    job?.result.reject(Object.assign(new Error('cancelled'), { cancelled: true }));
    await flush();
    expect(events.at(-1)).toEqual({
      channel: 'export.error',
      payload: { jobId, message: 'Export cancelled.', cancelled: true },
    });
  });

  it('reports failures', async () => {
    const { doc, call, jobs, events } = setup();
    const { jobId } = await call<{ jobId: string }>('export.start', {
      projectId: doc.id,
      options: OPTIONS,
    });
    jobs[0]?.result.reject(new Error('Export failed: disk full'));
    await flush();
    expect(events.at(-1)).toEqual({
      channel: 'export.error',
      payload: { jobId, message: 'Export failed: disk full', cancelled: false },
    });
  });
});

describe('export temp files (R1.47)', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  /** A real exports folder with our temp file for `Lesson test.mp4` and lookalikes. */
  async function exportsDir() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-export-handlers-'));
    dirs.push(dir);
    const ours = path.join(dir, exportTempName('Lesson test.mp4', '0123abcd'));
    const keep = [
      'Lesson test.mp4', // a finished export
      '.Lesson test.mp4.part', // no token
      '.Lesson test.mp4.0123ABCD.part', // not our token shape
      exportTempName('Other.mp4', '89abcdef'), // another export's temp file
      'notes.part',
    ].map((name) => path.join(dir, name));
    for (const file of [ours, ...keep]) await fs.writeFile(file, 'x');
    return { dir, ours, keep };
  }

  const withExportsDir = (dir: string): Partial<ExportHandlerDeps> => ({
    settings: () => createDefaultSettings({ projectsDir: '/videos/CS', exportsDir: dir }),
  });

  it('deletes the temp output when the utility dies mid-export', async () => {
    const { dir, ours, keep } = await exportsDir();
    const { doc, call, jobs, events } = setup({ ...withExportsDir(dir), processStartMs: 0 });
    const { jobId } = await call<{ jobId: string }>('export.start', {
      projectId: doc.id,
      options: OPTIONS,
    });
    // `runJob` rejects every outstanding job when the utility process exits.
    jobs[0]?.result.reject(new Error('media utility exited (null)'));
    await vi.waitFor(() => expect(existsSync(ours)).toBe(false));
    expect(keep.every((file) => existsSync(file))).toBe(true);
    expect(events.at(-1)).toMatchObject({ channel: 'export.error', payload: { jobId } });
  });

  it('cancels running exports and deletes their temp output on quit', async () => {
    const { dir, ours, keep } = await exportsDir();
    const { doc, call, jobs, service } = setup({ ...withExportsDir(dir), processStartMs: 0 });
    await call('export.start', { projectId: doc.id, options: OPTIONS });
    service.dispose();
    // Synchronous: the utility is stopped right after.
    expect(jobs[0]?.options.signal?.aborted).toBe(true);
    expect(existsSync(ours)).toBe(false);
    expect(keep.every((file) => existsSync(file))).toBe(true);
  });

  it('leaves the output and other files alone when an export succeeds', async () => {
    const { dir, ours } = await exportsDir();
    const { doc, call, jobs } = setup({ ...withExportsDir(dir), processStartMs: 0 });
    await call('export.start', { projectId: doc.id, options: OPTIONS });
    jobs[0]?.result.resolve({
      output: path.join(dir, 'Lesson test.mp4'),
      encoder: 'libx264',
      fallback: null,
      durationUs: 1,
      sizeBytes: 1,
      elapsedMs: 1,
    });
    await flush();
    await flush();
    // An unrelated leftover of the same name is the startup sweep's business, not this job's.
    expect(existsSync(ours)).toBe(true);
  });

  it('sweeps stale temp files of ours from the exports folder at startup', async () => {
    const { dir, ours, keep } = await exportsDir();
    const fresh = path.join(dir, exportTempName('Running.mp4', 'aaaabbbb'));
    await fs.writeFile(fresh, 'x');
    const startMs = Date.now() - 1000;
    const old = new Date(startMs - 60_000);
    for (const file of [ours, ...keep]) utimesSync(file, old, old);
    const { service } = setup({ ...withExportsDir(dir), processStartMs: startMs });
    expect(await service.sweeping).toEqual(
      [ours, path.join(dir, exportTempName('Other.mp4', '89abcdef'))].sort(),
    );
    expect(existsSync(ours)).toBe(false);
    // Newer than the process: possibly an export running now.
    expect(existsSync(fresh)).toBe(true);
    expect(keep.filter((f) => !f.includes('Other.mp4')).every((f) => existsSync(f))).toBe(true);
  });

  it('ignores a missing exports folder', async () => {
    expect(await sweepStaleExportTemps('/nonexistent/Exports', Date.now())).toEqual([]);
  });

  it('names temp files so that only ours match', () => {
    expect(exportTempName('Lesson.mp4', '0123abcd')).toBe('.Lesson.mp4.0123abcd.part');
    expect(() => exportTempName('Lesson.mp4', 'xyz')).toThrow();
    expect(exportTempOwner('.Lesson.mp4.0123abcd.part')).toBe('Lesson.mp4');
    expect(exportTempOwner('.a.b.mp4.ffffffff.part')).toBe('a.b.mp4');
    for (const name of [
      'Lesson.mp4',
      '.Lesson.mp4.part',
      '.Lesson.mp4.0123abc.part',
      '.Lesson.mp4.0123abcdd.part',
      'Lesson.mp4.0123abcd.part',
      '.0123abcd.part',
    ]) {
      expect(exportTempOwner(name), name).toBeNull();
    }
  });
});

describe('export helpers', () => {
  it('makes safe file names', () => {
    expect(exportFileName('Lesson 2026-10-24 09-45')).toBe('Lesson 2026-10-24 09-45.mp4');
    expect(exportFileName('a/b\\c')).toBe('a-b-c.mp4');
    expect(exportFileName('..hidden')).toBe('hidden.mp4');
    expect(exportFileName('  ')).toBe('Export.mp4');
  });

  it('estimates the time left', () => {
    expect(estimateEtaSec(null, 1000)).toBeNull();
    expect(estimateEtaSec(0.005, 1000)).toBeNull();
    expect(estimateEtaSec(0.5, 20_000)).toBe(20);
    expect(estimateEtaSec(1, 20_000)).toBe(0);
  });
});
