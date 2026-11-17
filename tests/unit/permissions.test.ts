import { describe, expect, it, vi } from 'vitest';
import { readMacPermissions } from '../../src/main/capabilities/mac-permissions';
import type { MacPermissions } from '../../src/main/capabilities/macos';
import {
  MAC_SETTINGS_URLS,
  PermissionService,
  permissionsReport,
  recordingBlockedReason,
} from '../../src/main/permissions/permission-service';
import { parseFakeMacPermissions } from '../../src/main/permissions/register';

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const GRANTED: MacPermissions = {
  screen: 'granted',
  camera: 'granted',
  microphone: 'granted',
  accessibility: false,
  inputMonitoring: 'granted',
};

describe('macOS permission report (P3 step 3, R3.6)', () => {
  it('applies only on macOS', () => {
    expect(permissionsReport(null)).toEqual({ applies: false, items: [], recordingBlocked: null });
  });

  it('lists each permission with its purpose; Screen Recording is the required one', () => {
    const report = permissionsReport(GRANTED);
    expect(report.items.map((i) => [i.kind, i.status, i.required])).toEqual([
      ['screen', 'granted', true],
      ['camera', 'granted', false],
      ['microphone', 'granted', false],
      ['inputMonitoring', 'granted', false],
    ]);
    expect(report.items.every((i) => i.purpose.length > 10 && !i.canRequest)).toBe(true);
    // Without the helper, Input Monitoring is not asked about at all.
    const { inputMonitoring: _, ...noHelper } = GRANTED;
    expect(permissionsReport(noHelper).items.map((i) => i.kind)).not.toContain('inputMonitoring');
  });

  it('blocks screen recording only when Screen Recording is off or restricted', () => {
    expect(recordingBlockedReason(GRANTED)).toBeNull();
    expect(recordingBlockedReason({ ...GRANTED, screen: 'not-determined' })).toBeNull();
    expect(recordingBlockedReason({ ...GRANTED, screen: 'denied' })).toMatch(/Screen Recording/);
    expect(recordingBlockedReason({ ...GRANTED, screen: 'restricted' })).toMatch(/blocked/);
  });

  it('offers macOS’s prompt only where macOS has one', () => {
    const items = permissionsReport({
      screen: 'not-determined',
      camera: 'not-determined',
      microphone: 'denied',
      accessibility: false,
      inputMonitoring: 'denied',
    }).items;
    const can = Object.fromEntries(items.map((i) => [i.kind, i.canRequest]));
    // No prompt API for Screen Recording; a refused microphone only changes in System Settings.
    expect(can).toEqual({
      screen: false,
      camera: true,
      microphone: false,
      inputMonitoring: true,
    });
  });
});

describe('PermissionService', () => {
  function service(initial: MacPermissions) {
    const state = { ...initial };
    const opened: string[] = [];
    const changes: (MacPermissions | null)[] = [];
    const ask = vi.fn((kind: 'camera' | 'microphone') => {
      state[kind] = 'granted';
      return Promise.resolve(true);
    });
    const s = new PermissionService({
      read: () => ({ ...state }),
      askForMediaAccess: ask,
      requestInputAccess: () => {
        state.inputMonitoring = 'granted';
        return true;
      },
      openUrl: (url) => {
        opened.push(url);
        return Promise.resolve();
      },
      onChange: (p) => changes.push(p),
      logger,
    });
    return { s, state, opened, changes, ask };
  }

  it('re-reads on recheck and reports a change once', () => {
    const { s, state, changes } = service({ ...GRANTED, screen: 'denied' });
    expect(s.recheck().recordingBlocked).not.toBeNull();
    expect(changes).toHaveLength(0);
    state.screen = 'granted';
    expect(s.recordingBlocked()).toBeNull();
    expect(s.recheck().recordingBlocked).toBeNull();
    s.recheck();
    expect(changes).toEqual([expect.objectContaining({ screen: 'granted' })]);
  });

  it('asks macOS where it can and opens System Settings otherwise', async () => {
    const { s, opened, ask } = service({
      ...GRANTED,
      camera: 'not-determined',
      microphone: 'denied',
      screen: 'denied',
      inputMonitoring: 'denied',
    });
    expect((await s.request('camera')).items.find((i) => i.kind === 'camera')?.status).toBe(
      'granted',
    );
    expect(ask).toHaveBeenCalledWith('camera');
    await s.request('microphone');
    await s.request('screen');
    expect(ask).toHaveBeenCalledTimes(1);
    expect(opened).toEqual([MAC_SETTINGS_URLS.microphone, MAC_SETTINGS_URLS.screen]);
    const after = await s.request('inputMonitoring');
    expect(after.items.find((i) => i.kind === 'inputMonitoring')?.status).toBe('granted');
  });

  it('opens only its fixed System Settings panes', async () => {
    const { s, opened } = service(GRANTED);
    expect(await s.openSettings('inputMonitoring')).toBe(true);
    expect(opened).toEqual([
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
    ]);
    for (const url of Object.values(MAC_SETTINGS_URLS)) {
      expect(url.startsWith('x-apple.systempreferences:com.apple.preference.security?')).toBe(true);
    }
  });

  it('does nothing where nothing applies', async () => {
    const opened: string[] = [];
    const s = new PermissionService({
      read: () => null,
      openUrl: (url) => {
        opened.push(url);
        return Promise.resolve();
      },
      onChange: () => undefined,
      logger,
    });
    expect(s.recheck().applies).toBe(false);
    expect(s.recordingBlocked()).toBeNull();
    expect(await s.openSettings('screen')).toBe(false);
    expect(opened).toEqual([]);
  });
});

describe('reading macOS permissions', () => {
  const prefs = {
    getMediaAccessStatus: () => 'granted',
    isTrustedAccessibilityClient: () => false,
  };

  it('takes Input Monitoring from the helper, when it is there', () => {
    expect(readMacPermissions(prefs, () => true).inputMonitoring).toBe('granted');
    expect(readMacPermissions(prefs, () => false).inputMonitoring).toBe('denied');
    expect(readMacPermissions(prefs)).not.toHaveProperty('inputMonitoring');
    expect(readMacPermissions(prefs, () => null)).not.toHaveProperty('inputMonitoring');
  });

  it('parses the test-mode description of a Mac', () => {
    expect(parseFakeMacPermissions('{"screen":"denied","inputMonitoring":"denied"}')).toEqual({
      screen: 'denied',
      camera: 'granted',
      microphone: 'granted',
      accessibility: false,
      inputMonitoring: 'denied',
    });
    expect(parseFakeMacPermissions('{"camera":"bogus"}')?.camera).toBe('granted');
    expect(parseFakeMacPermissions('not json')).toBeNull();
    expect(parseFakeMacPermissions(null)).toBeNull();
  });
});
