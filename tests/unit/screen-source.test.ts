/**
 * Screen-source selection (§9.1, R1.8): on GNOME Wayland, Cancel in the ScreenCast portal makes
 * `desktopCapturer.getSources` reject ("Failed to get sources."), which must count as cancelled.
 */
import { describe, expect, it, vi } from 'vitest';
import { isPortalCancellation, selectScreenSource } from '../../src/main/screen-source';
import { ALL_SCREENS_SOURCE_ID, type GetSources } from '../../src/main/display-media';

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const rejecting: GetSources = () => Promise.reject(new Error('Failed to get sources.'));

describe('selectScreenSource (R1.8)', () => {
  it('treats a rejecting getSources as a cancelled portal, and logs it', async () => {
    const log = logger();
    await expect(selectScreenSource(rejecting, { fps: 30, portal: true }, log)).resolves.toBeNull();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('treated as cancelled'));
    expect(log.error).not.toHaveBeenCalled();
  });

  it('logs an unrecognised portal failure as a warning but still returns to the panel', async () => {
    const log = logger();
    const odd: GetSources = () => Promise.reject(new Error('PipeWire went away'));
    await expect(selectScreenSource(odd, { fps: 30, portal: true }, log)).resolves.toBeNull();
    expect(log.warn).toHaveBeenCalled();
  });

  it('keeps a rejection a failure where no portal is involved (X11)', async () => {
    await expect(
      selectScreenSource(rejecting, { fps: 30, portal: false }, logger()),
    ).rejects.toThrow('Failed to get sources.');
  });

  it('returns the picked source, and null for an empty list', async () => {
    const sources: GetSources = () =>
      Promise.resolve([{ id: 'screen:1:0', name: 'Entire screen' }]);
    await expect(selectScreenSource(sources, { fps: 60, portal: true }, logger())).resolves.toEqual(
      {
        sourceId: 'screen:1:0',
        label: 'Entire screen',
        maxWidth: 3840,
        maxHeight: 2160,
      },
    );
    const empty: GetSources = () => Promise.resolve([]);
    await expect(
      selectScreenSource(empty, { fps: 30, portal: true }, logger()),
    ).resolves.toBeNull();
  });

  it('keeps the monitor’s display id (cursor mapping and overlays need it)', async () => {
    const sources: GetSources = () =>
      Promise.resolve([{ id: 'screen:1:0', name: 'Left', display_id: '42' }]);
    await expect(
      selectScreenSource(sources, { fps: 30, portal: false }, logger()),
    ).resolves.toMatchObject({ sourceId: 'screen:1:0', displayId: '42' });
  });

  it('offers "All screens" with several monitors, at a wider capture cap (P3 step 7)', async () => {
    const seen: string[][] = [];
    const two: GetSources = () =>
      Promise.resolve([
        { id: 'screen:1:0', name: 'Left', display_id: '1' },
        { id: 'screen:2:0', name: 'Right', display_id: '2' },
      ]);
    const all = await selectScreenSource(
      two,
      {
        fps: 30,
        portal: false,
        allScreens: true,
        chooseSource: (list) => {
          seen.push(list.map((s) => s.name));
          return Promise.resolve(ALL_SCREENS_SOURCE_ID);
        },
      },
      logger(),
    );
    expect(seen).toEqual([['Left', 'Right', 'All screens']]);
    expect(all).toEqual({
      sourceId: 'screen:-1:0',
      label: 'All screens',
      allScreens: true,
      maxWidth: 7680,
      maxHeight: 2160,
    });

    // Not with one monitor, not for windows, not when the capability is missing.
    const lists: string[][] = [];
    const record = (list: readonly { name: string }[]) => {
      lists.push(list.map((s) => s.name));
      return Promise.resolve(null);
    };
    await selectScreenSource(two, { fps: 30, portal: false, chooseSource: record }, logger());
    await selectScreenSource(
      two,
      { fps: 30, portal: false, allScreens: true, sourceType: 'window', chooseSource: record },
      logger(),
    );
    expect(lists).toEqual([
      ['Left', 'Right'],
      ['Left', 'Right'],
    ]);
    const one: GetSources = () => Promise.resolve([{ id: 'screen:1:0', name: 'Only' }]);
    await expect(
      selectScreenSource(one, { fps: 30, portal: false, allScreens: true }, logger()),
    ).resolves.toMatchObject({ sourceId: 'screen:1:0' });
  });

  it('recognises the Chromium message', () => {
    expect(isPortalCancellation('Failed to get sources.')).toBe(true);
    expect(isPortalCancellation('Not allowed')).toBe(false);
  });
});
