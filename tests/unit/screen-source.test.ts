/**
 * Screen-source selection (§9.1, R1.8): on GNOME Wayland, Cancel in the ScreenCast portal makes
 * `desktopCapturer.getSources` reject ("Failed to get sources."), which must count as cancelled.
 */
import { describe, expect, it, vi } from 'vitest';
import { isPortalCancellation, selectScreenSource } from '../../src/main/screen-source';
import type { GetSources } from '../../src/main/display-media';

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

  it('recognises the Chromium message', () => {
    expect(isPortalCancellation('Failed to get sources.')).toBe(true);
    expect(isPortalCancellation('Not allowed')).toBe(false);
  });
});
