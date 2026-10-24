/**
 * Project store (optimistic revisions, fallbacks, read-only newer formats) and the library
 * (listing, rename, trash, reveal, open folder) on temporary folders.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Library } from '../../src/main/projects/library';
import { ProjectRootRegistry } from '../../src/main/projects/media-protocol';
import {
  MAX_PROJECT_BACKUPS,
  ProjectStore,
  ProjectStoreError,
} from '../../src/main/projects/project-store';
import {
  projectFromRecording,
  type RecordingManifest,
} from '../../src/shared/project/from-recording';
import type { ProjectV1 } from '../../src/shared/project/schema';
import { unwrap } from '../../src/shared/result';

let work: string;

beforeEach(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-projects-'));
});

afterEach(async () => {
  await fs.rm(work, { recursive: true, force: true });
});

let n = 0;
function project(name = 'Lesson', createdAt = '2026-10-24T14:05:12.345Z'): ProjectV1 {
  n += 1;
  const manifest: RecordingManifest = {
    version: 1,
    projectId: `prj_TEST${String(n).padStart(4, '0')}`,
    name,
    createdAt,
    appVersion: '0.1.0',
    recording: {
      state: 'complete',
      sessionId: 'ses_TEST',
      startedAt: createdAt,
      durationUs: 20_000_000,
      pauses: [{ startUs: 5_000_000, endUs: 8_000_000 }],
      source: { kind: 'monitor', widthPx: 1920, heightPx: 1080, region: null },
      platform: { os: 'linux', electron: '45', chromium: '156', ffmpeg: 'n9' },
    },
    frameRate: 30,
    streams: [
      {
        mediaId: `med_S${String(n)}`,
        role: 'screen',
        path: 'media/screen.mp4',
        status: 'ok',
        durationUs: 20_000_000,
        startOffsetUs: 0,
        clockRatio: 1,
        endedEarly: false,
        sync: { mode: 'shared', offsetUs: 0, clockHandshakeUs: null },
        video: {
          codec: 'h264',
          width: 1920,
          height: 1080,
          frameRateNominal: 30,
          variableFrameRate: true,
        },
      },
      {
        role: 'microphone',
        path: 'media/mic.mp4',
        status: 'ok',
        durationUs: 20_000_000,
        startOffsetUs: 0,
        clockRatio: 1,
        endedEarly: false,
        sync: { mode: 'arrival-calibrated', offsetUs: 0, clockHandshakeUs: null },
        audio: { codec: 'opus', sampleRate: 48_000, channels: 1, discontinuities: 0 },
      },
    ],
  };
  return unwrap(projectFromRecording(manifest));
}

function newStore(): { store: ProjectStore; registry: ProjectRootRegistry } {
  const registry = new ProjectRootRegistry();
  return { store: new ProjectStore({ registry }), registry };
}

describe('project store', () => {
  it('opens a project with media URLs and registers its folder', async () => {
    const { store, registry } = newStore();
    const root = path.join(work, 'A.cstudio');
    const doc = project();
    await store.write(root, doc);
    const opened = await store.open(doc.id);
    expect(opened.doc.id).toBe(doc.id);
    expect(opened.readOnly).toBe(false);
    expect(opened.revision).toBe(1);
    expect(opened.mediaUrls[doc.media[0]!.id]).toBe(
      `cs-media://${doc.id.toLowerCase()}/media/screen.mp4`,
    );
    expect(registry.resolve(doc.id)).toBe(root);
  });

  it('saves with optimistic revisions and rejects a stale one', async () => {
    const { store } = newStore();
    const root = path.join(work, 'A.cstudio');
    const doc = project();
    await store.write(root, doc);
    const { revision } = await store.open(doc.id);

    const first = await store.save(doc.id, revision, { ...doc, name: 'Edited' });
    expect(first.revision).toBe(revision + 1);
    // A second editor still holding the old revision is rejected and changes nothing.
    await expect(store.save(doc.id, revision, { ...doc, name: 'Stale' })).rejects.toMatchObject({
      code: 'stale-revision',
    });
    expect((await store.open(doc.id)).doc.name).toBe('Edited');
    // Main's own writes bump the revision too.
    await store.update(doc.id, (d) => ({ ...d, name: 'Renamed' }));
    await expect(
      store.save(doc.id, first.revision, { ...doc, name: 'Late' }),
    ).rejects.toBeInstanceOf(ProjectStoreError);
    const current = await store.open(doc.id);
    expect(current.revision).toBe(first.revision + 1);
    expect(current.doc.name).toBe('Renamed');
  });

  it('serializes concurrent saves: exactly one of two same-revision saves wins', async () => {
    const { store } = newStore();
    const doc = project();
    await store.write(path.join(work, 'A.cstudio'), doc);
    const results = await Promise.allSettled([
      store.save(doc.id, 1, { ...doc, name: 'One' }),
      store.save(doc.id, 1, { ...doc, name: 'Two' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
  });

  it('rejects an invalid document and a doc for another project', async () => {
    const { store } = newStore();
    const doc = project();
    await store.write(path.join(work, 'A.cstudio'), doc);
    const broken = structuredClone(doc);
    broken.timeline.canvas.width = 63;
    await expect(store.save(doc.id, 1, broken)).rejects.toThrow();
    await expect(store.save(doc.id, 1, project())).rejects.toMatchObject({ code: 'mismatch' });
    await expect(store.open('prj_UNKNOWN')).rejects.toMatchObject({ code: 'unknown-project' });
  });

  it('keeps rolling backups of editor saves (newest 20)', async () => {
    const { store } = newStore();
    const root = path.join(work, 'A.cstudio');
    const doc = project();
    await store.write(root, doc);
    let revision = 1;
    for (let i = 0; i < MAX_PROJECT_BACKUPS + 3; i += 1) {
      ({ revision } = await store.save(doc.id, revision, { ...doc, name: `v${String(i)}` }));
    }
    const backups = await fs.readdir(path.join(root, 'backups'));
    expect(backups).toHaveLength(MAX_PROJECT_BACKUPS);
  });

  it('falls back to project.json.bak when project.json is damaged (R1.28)', async () => {
    const { store } = newStore();
    const root = path.join(work, 'A.cstudio');
    const doc = project();
    await store.write(root, doc);
    await store.write(root, { ...doc, name: 'Second' });
    await fs.writeFile(path.join(root, 'project.json'), '{"format": "capture-stu');
    const opened = await store.open(doc.id);
    expect(opened.doc.name).toBe(doc.name);
  });

  it('opens a newer-format project read-only and refuses to save it (R1.30)', async () => {
    const { store } = newStore();
    const root = path.join(work, 'A.cstudio');
    const doc = project();
    await store.write(root, doc);
    await fs.writeFile(
      path.join(root, 'project.json'),
      JSON.stringify({ ...doc, formatVersion: 2, futureField: true }),
    );
    const opened = await store.open(doc.id);
    expect(opened.readOnly).toBe(true);
    await expect(store.save(doc.id, opened.revision, opened.doc)).rejects.toMatchObject({
      code: 'read-only',
    });
  });
});

describe('library', () => {
  async function setup() {
    const { store, registry } = newStore();
    const projectsDir = path.join(work, 'Projects');
    const trashed: string[] = [];
    const revealed: string[] = [];
    const opened: string[] = [];
    let busy: string[] = [];
    const library = new Library({
      store,
      projectsDir: () => projectsDir,
      trashItem: async (p) => {
        trashed.push(p);
        await fs.rm(p, { recursive: true });
      },
      showItemInFolder: (p) => revealed.push(p),
      openPath: (p) => {
        opened.push(p);
        return Promise.resolve('');
      },
      busyRoots: () => busy,
    });
    const a = project('Older lesson', '2026-10-20T10:00:00.000Z');
    const b = project('Newer lesson', '2026-10-24T10:00:00.000Z');
    await store.write(path.join(projectsDir, 'Older lesson.cstudio'), a);
    await store.write(path.join(projectsDir, 'Newer lesson.cstudio'), b);
    await fs.mkdir(path.join(projectsDir, 'Older lesson.cstudio', 'cache'), { recursive: true });
    await fs.writeFile(
      path.join(projectsDir, 'Older lesson.cstudio', 'cache', `${a.media[0]!.id}.thumbs.json`),
      JSON.stringify({ sheets: [`${a.media[0]!.id}.thumbs.0.jpg`] }),
    );
    // Noise the scan must skip.
    await fs.mkdir(path.join(projectsDir, 'Exports'), { recursive: true });
    await fs.mkdir(path.join(projectsDir, 'Broken.cstudio'), { recursive: true });
    await fs.writeFile(path.join(projectsDir, 'Broken.cstudio', 'project.json'), 'nope');
    return {
      library,
      store,
      registry,
      projectsDir,
      a,
      b,
      trashed,
      revealed,
      opened,
      setBusy: (roots: string[]) => {
        busy = roots;
      },
    };
  }

  it('lists projects newest first with duration, badges and thumbnail (R1.27)', async () => {
    const { library, a, b } = await setup();
    const entries = await library.list();
    expect(entries.map((e) => e.id)).toEqual([b.id, a.id]);
    const older = entries[1]!;
    expect(older).toMatchObject({
      name: 'Older lesson',
      durationUs: 17_000_000, // 20 s minus the 3 s pause
      components: ['screen', 'voice'],
      state: 'complete',
    });
    expect(older.thumbUrl).toBe(
      `cs-media://${a.id.toLowerCase()}/cache/${a.media[0]!.id}.thumbs.0.jpg`,
    );
    expect(entries[0]!.thumbUrl).toBeNull();
  });

  it('returns an empty list when the projects folder does not exist', async () => {
    const { store } = newStore();
    const library = new Library({
      store,
      projectsDir: () => path.join(work, 'missing'),
      trashItem: () => Promise.resolve(),
      showItemInFolder: () => undefined,
      openPath: () => Promise.resolve(''),
    });
    expect(await library.list()).toEqual([]);
  });

  it('renames the project and its folder, resolving clashes', async () => {
    const { library, store, registry, projectsDir, a } = await setup();
    await library.list();
    const entry = await library.rename(a.id, 'Newer lesson');
    expect(entry.name).toBe('Newer lesson');
    const root = path.join(projectsDir, 'Newer lesson (2).cstudio');
    expect(store.rootOf(a.id)).toBe(root);
    expect(registry.resolve(a.id)).toBe(root);
    expect((await store.open(a.id)).doc.name).toBe('Newer lesson');
    await expect(fs.stat(path.join(projectsDir, 'Older lesson.cstudio'))).rejects.toThrow();
    // Renaming to a name with invalid characters keeps the display name and sanitizes the folder.
    await library.rename(a.id, 'Week 3: a/b');
    expect(store.rootOf(a.id)).toBe(path.join(projectsDir, 'Week 3_ a_b.cstudio'));
    expect((await store.open(a.id)).doc.name).toBe('Week 3: a/b');
  });

  it('moves a project to the trash, reveals it and opens the folder', async () => {
    const { library, a, b, trashed, revealed, opened, projectsDir } = await setup();
    await library.reveal(b.id);
    expect(revealed).toEqual([path.join(projectsDir, 'Newer lesson.cstudio')]);
    expect(await library.trash(a.id)).toEqual({ trashed: true });
    expect(trashed).toEqual([path.join(projectsDir, 'Older lesson.cstudio')]);
    expect((await library.list()).map((e) => e.id)).toEqual([b.id]);
    await library.openFolder();
    expect(opened).toEqual([projectsDir]);
  });

  it('refuses to rename or trash a recording in progress', async () => {
    const { library, a, projectsDir, setBusy } = await setup();
    setBusy([path.join(projectsDir, 'Older lesson.cstudio')]);
    await expect(library.rename(a.id, 'X')).rejects.toBeInstanceOf(ProjectStoreError);
    await expect(library.trash(a.id)).rejects.toBeInstanceOf(ProjectStoreError);
  });
});
