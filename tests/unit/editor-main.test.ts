/**
 * Main-process side of the editor (steps 16–18): offline media detection (R1.29), peaks and
 * thumbnails on demand (R1.44), relink, and the editor window host (one window per project,
 * autosave flush before closing).
 */
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcRouter } from '../../src/main/ipc/router';
import { EditorMedia, markMediaPresence } from '../../src/main/projects/editor-media';
import { ProjectRootRegistry } from '../../src/main/projects/media-protocol';
import { ProjectStore } from '../../src/main/projects/project-store';
import { exampleProject } from '../fixtures/example-project';

vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0' }, BrowserWindow: vi.fn() }));
const { EditorWindowHost } = await import('../../src/main/windows/editor');

let base: string;
let root: string;
let store: ProjectStore;
const doc = exampleProject();

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cs-editor-')));
  root = path.join(base, 'Lesson.cstudio');
  await fs.mkdir(path.join(root, 'media'), { recursive: true });
  for (const m of doc.media.filter((m) => m.role !== 'camera')) {
    await fs.writeFile(path.join(root, m.path), 'data');
  }
  store = new ProjectStore({ registry: new ProjectRootRegistry() });
  await store.write(root, doc);
});

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

describe('offline media (R1.29)', () => {
  it('marks a missing file offline and a returned one ok again', async () => {
    const marked = await markMediaPresence(root, doc);
    expect(marked.media.map((m) => m.status)).toEqual(['ok', 'missing', 'ok', 'ok']);
    await fs.writeFile(path.join(root, 'media/camera.mp4'), 'back');
    const back = await markMediaPresence(root, marked);
    expect(back.media[1]?.status).toBe('ok');
    expect(await markMediaPresence(root, back)).toBe(back);
  });
});

describe('peaks and thumbnails on demand (R1.44)', () => {
  function media(runJob = vi.fn(() => Promise.resolve({} as never))) {
    return {
      runJob,
      service: new EditorMedia({
        store,
        findRoot: (id) => Promise.resolve(id === doc.id ? root : null),
        runJob,
        chooseFile: () => Promise.resolve(path.join(base, 'replacement.mp4')),
      }),
    };
  }

  it('answers ready with the cache URL, pending while generating, unavailable otherwise', async () => {
    const { service, runJob } = media();
    expect(await service.asset('peaks', doc.id, 'med_m')).toEqual({ status: 'pending', url: null });
    await vi.waitFor(() =>
      expect(runJob).toHaveBeenCalledWith({
        kind: 'peaks',
        input: path.join(root, 'media/mic.mp4'),
        output: path.join(root, 'cache/med_m.peaks'),
      }),
    );
    await fs.writeFile(path.join(root, 'cache/med_m.peaks'), new Uint8Array(4));
    expect(await service.asset('peaks', doc.id, 'med_m')).toEqual({
      status: 'ready',
      url: `cs-media://${doc.id.toLowerCase()}/cache/med_m.peaks`,
    });
    // Wrong kind, missing file, unknown project or media.
    expect((await service.asset('peaks', doc.id, 'med_s')).status).toBe('unavailable');
    expect((await service.asset('thumbs', doc.id, 'med_c')).status).toBe('unavailable');
    expect((await service.asset('thumbs', 'prj_nope', 'med_s')).status).toBe('unavailable');
    expect((await service.asset('thumbs', doc.id, 'med_nope')).status).toBe('unavailable');
    expect(await service.asset('thumbs', doc.id, 'med_s')).toEqual({
      status: 'pending',
      url: null,
    });
    expect(runJob).toHaveBeenLastCalledWith({
      kind: 'thumbnails',
      input: path.join(root, 'media/screen.mp4'),
      outDir: path.join(root, 'cache'),
      mediaId: 'med_s',
    });
  });

  it('gives up on a media whose job failed', async () => {
    const { service } = media(vi.fn(() => Promise.reject(new Error('ffmpeg failed'))));
    expect((await service.asset('peaks', doc.id, 'med_y')).status).toBe('pending');
    await new Promise((r) => setTimeout(r, 10));
    expect((await service.asset('peaks', doc.id, 'med_y')).status).toBe('unavailable');
  });

  it('relinks a missing file by copying the chosen one into the project', async () => {
    await fs.writeFile(path.join(base, 'replacement.mp4'), 'camera');
    store.register(doc.id, root);
    const { service } = media();
    expect(await service.relink(doc.id, 'med_c', 1)).toBe(true);
    expect(await fs.readFile(path.join(root, 'media/camera.mp4'), 'utf8')).toBe('camera');
    const reread = await store.read(root);
    expect(reread?.doc.media[1]?.status).toBe('ok');
  });
});

class FakeWindow extends EventEmitter {
  destroyed = false;
  focused = 0;
  js: string[] = [];
  webContents = {
    id: Math.floor(Math.random() * 1e6),
    isDestroyed: () => this.destroyed,
    executeJavaScript: (code: string) => {
      this.js.push(code);
      return Promise.resolve(null);
    },
  };
  isDestroyed() {
    return this.destroyed;
  }
  isMinimized() {
    return false;
  }
  restore() {
    this.emit('restore');
  }
  show() {
    this.emit('show');
  }
  focus() {
    this.focused += 1;
  }
  close() {
    const event = {
      defaultPrevented: false,
      preventDefault: () => (event.defaultPrevented = true),
    };
    this.emit('close', event);
    if (event.defaultPrevented) return;
    this.destroyed = true;
    this.emit('closed');
  }
}

describe('EditorWindowHost', () => {
  function setup() {
    const registered: string[] = [];
    const router = {
      registerWindow: (_c: unknown, kind: string) => {
        registered.push(kind);
        return () => undefined;
      },
    } as unknown as IpcRouter;
    const windows: FakeWindow[] = [];
    const created: string[] = [];
    const host = new EditorWindowHost({
      router,
      renderer: { rendererDir: '/r', preloadDir: '/p' },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      createWindow: (_l, projectId) => {
        created.push(projectId);
        const w = new FakeWindow();
        windows.push(w);
        return w as never;
      },
    });
    return { host, windows, created, registered };
  }

  it('opens one window per project as an editor window and focuses an open one', () => {
    const { host, windows, created, registered } = setup();
    host.open('prj_a');
    host.open('prj_b');
    host.open('prj_a');
    expect(created).toEqual(['prj_a', 'prj_b']);
    expect(registered).toEqual(['editor', 'editor']);
    expect(windows[0]!.focused).toBe(1);
    expect(host.openProjects).toEqual(['prj_a', 'prj_b']);
  });

  it('flushes autosave before a window closes, then closes it', async () => {
    const { host, windows } = setup();
    host.open('prj_a');
    const w = windows[0]!;
    w.close();
    expect(w.destroyed).toBe(false);
    await vi.waitFor(() => expect(w.destroyed).toBe(true));
    expect(w.js[0]).toContain('__csEditorFlush');
    expect(host.openProjects).toEqual([]);
  });

  it('flushes every window once before quitting', async () => {
    const { host, windows } = setup();
    host.open('prj_a');
    host.open('prj_b');
    expect(await host.releaseForQuit()).toBe(true);
    expect(windows.map((w) => w.js.length)).toEqual([1, 1]);
    expect(host.isReleased).toBe(true);
    windows[0]!.close(); // closes at once now
    expect(windows[0]!.destroyed).toBe(true);
  });
});
