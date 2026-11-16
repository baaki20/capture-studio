/**
 * The real native helper (`npm run build:native`; P3 step 4): it loads, reports this platform's
 * backend, keeps one monotonic clock, lists windows and runs the cursor loop with its end batch.
 * With `CS_NATIVE_INPUT_TEST=1` on an X server of its own (CI's Xvfb), XTest moves and clicks the
 * pointer and the loop must report both. Never set it on a desktop someone is using.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { nativeHelperPath, type NativeHelper } from '../../src/main/native/cs-native';
import { decodeBatch, type RawCursorSample } from '../../src/main/recording/cursor-source';

const file = nativeHelperPath({
  isPackaged: false,
  resourcesPath: '',
  appPath: path.join(import.meta.dirname, '../..'),
});
const built = existsSync(file);
const helper = built ? (createRequire(import.meta.url)(file) as NativeHelper) : null;
const BACKEND = { linux: 'x11', win32: 'win32', darwin: 'macos' } as const;
const x11 = process.platform === 'linux' && Boolean(process.env.DISPLAY);
const inject = x11 && process.env.CS_NATIVE_INPUT_TEST === '1';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs the cursor loop while `during` acts; resolves with every sample after the end batch. */
async function record(during: () => Promise<void>): Promise<RawCursorSample[]> {
  const samples: RawCursorSample[] = [];
  let ended: () => void = () => undefined;
  const end = new Promise<void>((resolve) => (ended = resolve));
  helper!.startCursor(120, (batch) => {
    if (batch.length === 0) ended();
    else samples.push(...decodeBatch(batch));
  });
  await during();
  helper!.stopCursor();
  await end;
  return samples;
}

describe.skipIf(!built)('native helper', () => {
  it('reports this platform and a steady clock', async () => {
    const platform = process.platform as keyof typeof BACKEND;
    const expected =
      platform === 'linux' && !process.env.DISPLAY ? 'unsupported' : BACKEND[platform];
    expect(helper!.backend()).toBe(expected);
    expect(helper!.coordinateSpace()).toBe(platform === 'darwin' ? 'dip' : 'physical');
    const a = helper!.monotonicUs();
    await wait(20);
    const b = helper!.monotonicUs();
    expect(b - a).toBeGreaterThanOrEqual(15_000);
    expect(b - a).toBeLessThan(1_000_000);
  });

  it.skipIf(process.platform === 'linux' && !process.env.DISPLAY)(
    'lists windows and runs the cursor loop until stopped',
    async () => {
      expect(Array.isArray(helper!.listWindows())).toBe(true);
      const samples = await record(() => wait(100));
      // A pointer that does not move gives its position once.
      expect(samples.length).toBeGreaterThanOrEqual(1);
      expect(() => helper!.stopCursor()).not.toThrow();
    },
  );

  it.skipIf(!inject)('reports XTest moves and clicks at 120 Hz (R3.7)', async () => {
    const samples = await record(async () => {
      helper!.injectPointer('move', 100, 200);
      await wait(50);
      helper!.injectPointer('move', 640, 360);
      await wait(50);
      helper!.injectPointer('press', 0, 0, 1);
      helper!.injectPointer('release', 0, 0, 1);
      await wait(50);
      helper!.injectPointer('press', 0, 0, 3);
      helper!.injectPointer('release', 0, 0, 3);
      await wait(50);
    });
    const moves = samples.filter((s) => s.action === 'move').map((s) => [s.x, s.y]);
    expect(moves).toContainEqual([100, 200]);
    expect(moves).toContainEqual([640, 360]);
    const clicks = samples.filter((s) => s.action !== 'move');
    expect(clicks.map((s) => [s.action, s.button, s.x, s.y])).toEqual([
      ['down', 'left', 640, 360],
      ['up', 'left', 640, 360],
      ['down', 'right', 640, 360],
      ['up', 'right', 640, 360],
    ]);
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]!.tUs).toBeGreaterThanOrEqual(samples[i - 1]!.tUs);
    }
  });
});
