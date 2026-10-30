/**
 * The background peaks/thumbnails queue (R1.20, R1.44): one job per asset at a time (the editor
 * never starts a second one while finalize's background pass runs), bounded concurrency, peaks
 * first, held while recording.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheJobs, type CacheJobRunner } from '../../src/main/projects/cache-jobs';
import type { Media } from '../../src/shared/project/schema';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-caches-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const media = (id: string, kind: 'audio' | 'video'): Media =>
  ({ id, kind, path: `media/${id}.mp4`, status: 'ok', durationUs: 10e6 }) as unknown as Media;

/** A runner whose jobs finish when the test says so. */
function controlledRunner() {
  const started: string[] = [];
  const finish = new Map<string, (ok: boolean) => void>();
  const runJob = vi.fn((job: Parameters<CacheJobRunner>[0]) => {
    const name = job.kind === 'peaks' ? path.basename(job.output) : `${job.mediaId}.thumbs`;
    started.push(name);
    return new Promise((resolve, reject) => {
      finish.set(name, (ok) => (ok ? resolve({}) : reject(new Error('ffmpeg failed'))));
    });
  }) as unknown as CacheJobRunner;
  return { runJob, started, finish };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('CacheJobs', () => {
  it('runs at most two jobs at once, peaks first, and never twice for one asset', async () => {
    const { runJob, started, finish } = controlledRunner();
    const caches = new CacheJobs({ runJob });
    const all = caches.generateAll('prj', root, [
      media('screen', 'video'),
      media('camera', 'video'),
      media('mic', 'audio'),
      media('system', 'audio'),
    ]);
    await vi.waitFor(() => expect(started).toEqual(['mic.peaks', 'system.peaks']));
    // The editor asks for the screen thumbnails meanwhile: queued ahead, not duplicated.
    const editor = caches.ensure({ projectId: 'prj', root, media: media('screen', 'video') }, 0);
    expect(caches.isPending('prj', 'screen', 'thumbs')).toBe(true);
    finish.get('mic.peaks')?.(true);
    await vi.waitFor(() => expect(started).toEqual(['mic.peaks', 'system.peaks', 'screen.thumbs']));
    finish.get('system.peaks')?.(true);
    finish.get('screen.thumbs')?.(true);
    await editor;
    await vi.waitFor(() => expect(started).toHaveLength(4));
    finish.get('camera.thumbs')?.(true);
    await all;
    expect(started.filter((s) => s === 'screen.thumbs')).toHaveLength(1);
    expect(caches.isPending('prj', 'screen', 'thumbs')).toBe(false);
  });

  it('starts nothing while held (a recording is capturing)', async () => {
    const { runJob, started, finish } = controlledRunner();
    const caches = new CacheJobs({ runJob });
    caches.setHeld(true);
    const job = caches.ensure({ projectId: 'prj', root, media: media('mic', 'audio') });
    await tick();
    expect(started).toEqual([]);
    caches.setHeld(false);
    await vi.waitFor(() => expect(started).toEqual(['mic.peaks']));
    finish.get('mic.peaks')?.(true);
    await job;
  });

  it('remembers failures until cleared, and skips caches that exist', async () => {
    const { runJob, started, finish } = controlledRunner();
    const caches = new CacheJobs({
      runJob,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const job = caches.ensure({ projectId: 'prj', root, media: media('mic', 'audio') });
    await vi.waitFor(() => expect(started).toHaveLength(1));
    finish.get('mic.peaks')?.(false);
    await expect(job).rejects.toThrow('ffmpeg failed');
    expect(caches.hasFailed('prj', 'mic', 'peaks')).toBe(true);
    caches.clearFailures('prj');
    expect(caches.hasFailed('prj', 'mic', 'peaks')).toBe(false);

    await fs.mkdir(path.join(root, 'cache'), { recursive: true });
    await fs.writeFile(path.join(root, 'cache', 'mic.peaks'), '');
    await caches.generateAll('prj', root, [media('mic', 'audio')]);
    expect(started).toHaveLength(1);
  });
});
