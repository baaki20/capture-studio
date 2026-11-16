import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { registerUpdates } from '../../src/main/updates/register';
import {
  CHECK_EVERY_MS,
  FIRST_CHECK_MS,
  UpdateService,
  updateSupport,
  type UpdaterLike,
  type UpdateState,
} from '../../src/main/updates/update-service';

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** A fake electron-updater: `checkForUpdates` emits what `next` says. */
class FakeUpdater extends EventEmitter implements UpdaterLike {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  allowPrerelease = false;
  allowDowngrade = true;
  checks = 0;
  installs = 0;
  next: 'none' | 'available' | 'fail' = 'none';
  checkForUpdates(): Promise<unknown> {
    this.checks += 1;
    this.emit('checking-for-update');
    if (this.next === 'fail') {
      const error = new Error('net::ERR_INTERNET_DISCONNECTED');
      this.emit('error', error);
      return Promise.reject(error);
    }
    if (this.next === 'none') this.emit('update-not-available', { version: '0.3.0' });
    else this.emit('update-available', { version: '0.4.0' });
    return Promise.resolve({});
  }
  quitAndInstall(): void {
    this.installs += 1;
  }
}

function timers() {
  const queue: { fn: () => void; ms: number }[] = [];
  return {
    queue,
    setTimeout: (fn: () => void, ms: number) => {
      queue.push({ fn, ms });
      return queue.length;
    },
    clearTimeout: () => queue.splice(0),
  };
}

function service(settings = { channel: 'release' as const, autoCheck: true }) {
  const updater = new FakeUpdater();
  const t = timers();
  const current = { ...settings } as { channel: 'release' | 'pre-release'; autoCheck: boolean };
  const s = new UpdateService({
    updater,
    support: { supported: true, reason: '' },
    settings: () => current,
    logger,
    now: () => new Date('2026-11-16T12:00:00Z'),
    setTimeout: t.setTimeout,
    clearTimeout: t.clearTimeout,
  });
  const states: UpdateState['kind'][] = [];
  s.onChange((state) => states.push(state.kind));
  return { s, updater, t, current, states };
}

describe('update support (plan D4)', () => {
  const base = { isPackaged: true, appImage: undefined, macSigned: false };
  it('updates the NSIS install, the AppImage and a signed Mac app only', () => {
    expect(updateSupport({ ...base, platform: 'win32' }).supported).toBe(true);
    expect(updateSupport({ ...base, platform: 'linux', appImage: '/a.AppImage' }).supported).toBe(
      true,
    );
    expect(updateSupport({ ...base, platform: 'linux' }).reason).toMatch(/package manager/);
    expect(updateSupport({ ...base, platform: 'darwin' }).reason).toMatch(/not signed/);
    expect(updateSupport({ ...base, platform: 'darwin', macSigned: true }).supported).toBe(true);
    expect(updateSupport({ ...base, isPackaged: false, platform: 'win32' }).reason).toMatch(
      /Development/,
    );
  });
});

describe('update service', () => {
  it('configures the updater and follows a check to "up to date"', async () => {
    const { s, updater, states } = service();
    expect(updater).toMatchObject({ autoDownload: true, autoInstallOnAppQuit: true });
    expect(updater.allowDowngrade).toBe(false);
    await s.check();
    expect(states).toEqual(['checking', 'up-to-date']);
    expect(s.state).toEqual({ kind: 'up-to-date', checkedAt: '2026-11-16T12:00:00.000Z' });
  });

  it('downloads an update, reports progress, and installs only once it is ready', async () => {
    const { s, updater } = service();
    updater.next = 'available';
    await s.check();
    expect(s.state).toEqual({ kind: 'downloading', version: '0.4.0', percent: 0 });
    expect(s.install()).toBe(false);
    updater.emit('download-progress', { percent: 41.6 });
    expect(s.state).toMatchObject({ percent: 42 });
    // A check during the download does nothing.
    await s.check();
    expect(updater.checks).toBe(1);
    updater.emit('update-downloaded', { version: '0.4.0' });
    expect(s.state).toEqual({ kind: 'ready', version: '0.4.0' });
    expect(s.install()).toBe(true);
    expect(updater.installs).toBe(1);
  });

  it('follows the channel and reports failures', async () => {
    const { s, updater, current } = service();
    current.channel = 'pre-release';
    updater.next = 'fail';
    await s.check();
    expect(updater.allowPrerelease).toBe(true);
    expect(s.state).toEqual({ kind: 'error', message: 'net::ERR_INTERNET_DISCONNECTED' });
  });

  it('checks after start and then every few hours, only while automatic checks are on', async () => {
    const { s, t, updater, current } = service();
    s.start();
    expect(t.queue.map((q) => q.ms)).toEqual([FIRST_CHECK_MS]);
    t.queue.shift()?.fn();
    await vi.waitFor(() => expect(t.queue.map((q) => q.ms)).toEqual([CHECK_EVERY_MS]));
    expect(updater.checks).toBe(1);
    current.autoCheck = false;
    s.settingsChanged();
    expect(t.queue).toEqual([]);
  });

  it('never touches the updater where updates are unsupported', async () => {
    const updater = new FakeUpdater();
    const s = new UpdateService({
      updater,
      support: { supported: false, reason: 'Installed from a .deb package.' },
      settings: () => ({ channel: 'release', autoCheck: true }),
      logger,
    });
    s.start();
    await s.check();
    expect(s.state).toEqual({ kind: 'unsupported', reason: 'Installed from a .deb package.' });
    expect(updater.checks).toBe(0);
    expect(updater.autoDownload).toBe(false);
  });
});

describe('registerUpdates', () => {
  function router() {
    const handlers = new Map<string, () => unknown>();
    const broadcasts: unknown[] = [];
    return {
      handlers,
      broadcasts,
      handle: (channel: string, fn: () => unknown) => handlers.set(channel, fn),
      broadcast: (_channel: string, payload: unknown) => broadcasts.push(payload),
    };
  }

  it('loads no updater for a development build', async () => {
    const r = router();
    const loadUpdater = vi.fn(() => Promise.resolve(new FakeUpdater()));
    const s = await registerUpdates({
      router: r as never,
      isPackaged: false,
      platform: 'linux',
      env: {},
      execPath: '/x',
      settings: () => ({ channel: 'release', autoCheck: true }),
      logger,
      loadUpdater,
    });
    expect(loadUpdater).not.toHaveBeenCalled();
    expect(await r.handlers.get('updates.status')?.()).toMatchObject({ kind: 'unsupported' });
    s.dispose();
  });

  it('wires an AppImage build and forwards state changes', async () => {
    const r = router();
    const updater = new FakeUpdater();
    const s = await registerUpdates({
      router: r as never,
      isPackaged: true,
      platform: 'linux',
      env: { APPIMAGE: '/apps/capture-studio.AppImage' },
      execPath: '/x',
      settings: () => ({ channel: 'release', autoCheck: false }),
      logger,
      loadUpdater: () => Promise.resolve(updater),
    });
    expect(await r.handlers.get('updates.check')?.()).toMatchObject({ kind: 'up-to-date' });
    expect(r.broadcasts).toHaveLength(2);
    expect(r.handlers.get('updates.install')?.()).toEqual({ started: false });
    s.dispose();
  });
});
