import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingsStore } from '../../src/main/settings/store';
import { createDefaultSettings, SettingsV1Schema } from '../../src/shared/settings/schema';

let dir: string;
let file: string;
const defaults = {
  projectsDir: '/home/u/Videos/Capture Studio',
  exportsDir: '/home/u/Videos/Capture Studio/Exports',
};

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-settings-'));
  file = path.join(dir, 'settings.json');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function readJson(p: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(p, 'utf8'));
}

describe('SettingsStore', () => {
  it('creates defaults on first run without a notice', async () => {
    const store = await SettingsStore.open({ dir, defaults });
    expect(store.loadNotice).toBeNull();
    expect(store.get()).toEqual(createDefaultSettings(defaults));
    expect(SettingsV1Schema.parse(await readJson(file))).toEqual(store.get());
    expect(store.get().namePattern).toBe('Lesson %y-%mo-%d %h-%mi');
    expect(store.get().recorder.micProcessing).toEqual({ ec: false, ns: false, agc: false });
  });

  it('persists patches across restarts (R1.6) and keeps .bak', async () => {
    const store = await SettingsStore.open({ dir, defaults });
    await store.patch({ recorder: { fps: 60, micProcessing: { ns: true } } });
    await store.patch({ theme: 'dark' });

    const reopened = await SettingsStore.open({ dir, defaults });
    expect(reopened.get().recorder.fps).toBe(60);
    expect(reopened.get().recorder.micProcessing).toEqual({ ec: false, ns: true, agc: false });
    expect(reopened.get().theme).toBe('dark');
    expect(reopened.loadNotice).toBeNull();
    expect(await readJson(`${file}.bak`)).toMatchObject({ recorder: { fps: 60 }, theme: 'system' });
  });

  it('rejects an invalid patch and keeps the previous value', async () => {
    const store = await SettingsStore.open({ dir, defaults });
    await expect(store.patch({ recorder: { fps: 24 as 30 } })).rejects.toThrow();
    expect(store.get().recorder.fps).toBe(30);
    expect((await readJson(file)) as object).toMatchObject({ recorder: { fps: 30 } });
  });

  it('returns copies that cannot mutate the store', async () => {
    const store = await SettingsStore.open({ dir, defaults });
    store.get().recorder.fps = 60;
    expect(store.get().recorder.fps).toBe(30);
  });

  it('falls back to the backup when settings.json is corrupted, and tells the user (R1.50)', async () => {
    const store = await SettingsStore.open({ dir, defaults });
    await store.patch({ language: 'de' });
    await store.patch({ language: 'fr' }); // .bak now holds "de"

    await fs.writeFile(file, '{"schemaVersion":1,"projectsDir":'); // simulated torn write
    const reopened = await SettingsStore.open({
      dir,
      defaults,
      now: () => new Date('2026-10-24T09:00:00Z'),
    });

    expect(reopened.get().language).toBe('de');
    expect(reopened.loadNotice).toMatchObject({ kind: 'recovered-from-backup', source: 'bak' });
    expect(reopened.loadNotice?.quarantinedPath).toBe(`${file}.corrupt-20261024T090000Z`);
    // The main file was repaired from the backup.
    expect(await readJson(file)).toMatchObject({ language: 'de' });
    expect(await readJson(`${file}.bak`)).toMatchObject({ language: 'de' });
  });

  it('falls back when the file is valid JSON but fails validation', async () => {
    const store = await SettingsStore.open({ dir, defaults });
    await store.patch({ language: 'de' });
    await fs.writeFile(file, JSON.stringify({ ...store.get(), recorder: { fps: 'fast' } }));
    const reopened = await SettingsStore.open({ dir, defaults });
    expect(reopened.loadNotice?.kind).toBe('recovered-from-backup');
    expect(reopened.get().recorder.fps).toBe(30);
  });

  it('uses the weekly copy when file and .bak are both damaged', async () => {
    const now = () => new Date('2026-10-24T09:00:00Z');
    const store = await SettingsStore.open({ dir, defaults, now });
    await store.patch({ language: 'nl' });
    await fs.writeFile(file, '');
    await fs.writeFile(`${file}.bak`, '\u0000');
    const weekly = await fs.readdir(path.join(dir, 'Backup'));
    expect(weekly).toHaveLength(1);

    const reopened = await SettingsStore.open({ dir, defaults, now });
    expect(reopened.loadNotice).toMatchObject({ kind: 'recovered-from-backup', source: 'weekly' });
  });

  it('resets to defaults with a notice when nothing is readable', async () => {
    await fs.writeFile(file, 'not json');
    const store = await SettingsStore.open({
      dir,
      defaults,
      now: () => new Date('2026-10-24T09:00:00Z'),
    });
    expect(store.get()).toEqual(createDefaultSettings(defaults));
    expect(store.loadNotice?.kind).toBe('reset-to-defaults');
    expect(await fs.readFile(`${file}.corrupt-20261024T090000Z`, 'utf8')).toBe('not json');
  });

  it('does not load settings written by a newer schema version as if they were current', async () => {
    await fs.writeFile(
      file,
      JSON.stringify({ ...createDefaultSettings(defaults), schemaVersion: 2 }),
    );
    const store = await SettingsStore.open({ dir, defaults });
    expect(store.loadNotice?.kind).toBe('reset-to-defaults');
    // The newer file is kept, not deleted.
    expect((await fs.readdir(dir)).some((n) => n.startsWith('settings.json.corrupt-'))).toBe(true);
  });

  it('serializes concurrent saves', async () => {
    const store = await SettingsStore.open({ dir, defaults });
    await Promise.all(['a', 'b', 'c', 'd'].map((language) => store.patch({ language })));
    expect(((await readJson(file)) as { language: string }).language).toBe('d');
  });
});
