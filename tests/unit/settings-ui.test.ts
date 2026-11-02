/**
 * Settings in the shell (finding F-2, R1.50, R1.12): fields added after the first release load
 * from older files with their defaults, folders change only through main's dialog, the recovery
 * notice is handed out once, and the form's checks.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerCoreHandlers } from '../../src/main/ipc/core-handlers';
import type { IpcRouter } from '../../src/main/ipc/router';
import { SettingsStore } from '../../src/main/settings/store';
import { namePreview, parseDiskThresholds } from '../../src/renderer/shell/settings-form';
import { createDefaultSettings } from '../../src/shared/settings/schema';

let dir: string;
const defaults = { projectsDir: '/home/u/Videos/Capture Studio', exportsDir: '/home/u/Exports' };

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-settings-ui-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

type Handler = (payload: unknown, context: { kind: string; senderId: number }) => unknown;

async function handlers(options: { chooseFolder?: () => Promise<string | null> } = {}) {
  const store = await SettingsStore.open({ dir, defaults });
  const registered = new Map<string, Handler>();
  const router = {
    handle: (channel: string, fn: Handler) => registered.set(channel, fn),
  } as unknown as IpcRouter;
  registerCoreHandlers({
    router,
    capabilities: { current: () => null, refresh: () => Promise.resolve(null) } as never,
    settings: store,
    diagnostics: () => ({}) as never,
    probeEncoders: () => Promise.reject(new Error('unused')),
    writeClipboard: () => undefined,
    ...(options.chooseFolder ? { chooseFolder: options.chooseFolder } : {}),
  });
  const call = (channel: string, payload?: unknown, kind = 'shell') =>
    Promise.resolve().then(() => registered.get(channel)?.(payload, { kind, senderId: 1 }));
  return { store, call };
}

describe('settings added after the first release', () => {
  it('load from an older file with their defaults and without a notice', async () => {
    const old = createDefaultSettings(defaults) as Record<string, unknown>;
    const recorder = { ...(old.recorder as Record<string, unknown>) };
    delete recorder.confirmAbort;
    delete old.library;
    await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify({ ...old, recorder }));
    const store = await SettingsStore.open({ dir, defaults });
    expect(store.loadNotice).toBeNull();
    expect(store.get().recorder.confirmAbort).toBe(true);
    expect(store.get().library).toEqual({ importedRoots: [] });
  });
});

describe('automation setting', () => {
  it('is off by default and loads as off from older files', async () => {
    const old = createDefaultSettings(defaults) as Record<string, unknown>;
    delete old.automation;
    await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify(old));
    const store = await SettingsStore.open({ dir, defaults });
    expect(store.get().automation).toEqual({ enabled: false });
  });

  it('can be changed only from the shell, and tells listeners', async () => {
    const { store, call } = await handlers();
    const seen: boolean[] = [];
    store.onChange((s) => seen.push(s.automation.enabled));
    await expect(
      call('settings.patch', { automation: { enabled: true } }, 'editor'),
    ).rejects.toThrow(/may not change automation/);
    expect(store.get().automation.enabled).toBe(false);
    await call('settings.patch', { automation: { enabled: true } });
    expect(store.get().automation.enabled).toBe(true);
    await call('settings.patch', { theme: 'dark' }, 'editor');
    expect(seen).toEqual([true, true]);
  });
});

describe('settings handlers', () => {
  it('changes a folder only through the dialog, and not when it is cancelled', async () => {
    let answer: string | null = '/media/teacher/Lessons';
    const { store, call } = await handlers({ chooseFolder: () => Promise.resolve(answer) });
    const next = (await call('settings.chooseFolder', { which: 'projectsDir' })) as {
      projectsDir: string;
    };
    expect(next.projectsDir).toBe('/media/teacher/Lessons');
    expect(store.get().projectsDir).toBe('/media/teacher/Lessons');
    answer = null;
    expect(await call('settings.chooseFolder', { which: 'exportsDir' })).toBeNull();
    expect(store.get().exportsDir).toBe(defaults.exportsDir);
  });

  it('hands out the recovery notice once per launch (R1.50)', async () => {
    await fs.writeFile(path.join(dir, 'settings.json'), '{"schemaVersion":1,'); // torn
    const { call } = await handlers();
    expect(await call('settings.takeLoadNotice')).toMatchObject({ kind: 'reset-to-defaults' });
    expect(await call('settings.takeLoadNotice')).toBeNull();
  });

  it('has no notice after a clean start', async () => {
    const { call } = await handlers();
    expect(await call('settings.takeLoadNotice')).toBeNull();
  });
});

describe('settings form', () => {
  it('checks the disk thresholds', () => {
    expect(parseDiskThresholds('2', '500')).toEqual({ warnBytes: 2e9, stopBytes: 5e8 });
    expect(parseDiskThresholds('1.5', '0')).toEqual({ warnBytes: 1.5e9, stopBytes: 0 });
    expect(parseDiskThresholds('0.4', '500')).toMatch(/below the warning/);
    expect(parseDiskThresholds('', '500')).toMatch(/GB/);
    expect(parseDiskThresholds('2', '-1')).toMatch(/MB/);
  });

  it('previews the next folder name live', () => {
    const now = new Date(2026, 9, 24, 14, 5);
    expect(namePreview('Lesson %y-%mo-%d %h-%mi', 0, now)).toBe('Lesson 2026-10-24 14-05.cstudio');
    expect(namePreview('Take %i', 7, now)).toBe('Take 7.cstudio');
    expect(namePreview('  ', 0, now)).toBeNull();
  });
});
