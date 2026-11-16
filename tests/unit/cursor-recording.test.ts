import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadNativeHelper, nativeHelperPath } from '../../src/main/native/cs-native';
import {
  clockOffsetUs,
  CursorRecorder,
  monitorMapping,
} from '../../src/main/recording/cursor-recorder';
import {
  decodeBatch,
  nativeCursorSource,
  pollingCursorSource,
  type CursorSource,
  type RawCursorSample,
} from '../../src/main/recording/cursor-source';
import { createCursorTrackStarter, displayRect } from '../../src/main/recording/cursor-track-start';
import { withCursorMedia } from '../../src/main/recording/session-manager';
import { parseCursorTrack } from '../../src/shared/project/cursor-track';
import { checkProjectInvariants } from '../../src/shared/project/invariants';
import { exampleProject } from '../fixtures/example-project';

const logger = { info: vi.fn(), warn: vi.fn(), error: () => undefined };
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-cursor-rec-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** A source whose samples the test pushes, on a clock 1 000 000 µs behind main's. */
function fakeSource(options: { fail?: boolean; clicks?: boolean } = {}) {
  let push: ((s: readonly RawCursorSample[]) => void) | null = null;
  const source: CursorSource & { push(s: RawCursorSample[]): void } = {
    kind: 'native',
    coordinateSpace: 'physical',
    nowUs: () => main.us - 1_000_000,
    start(onSamples) {
      if (options.fail) throw new Error('no display');
      push = onSamples;
      return { clicks: options.clicks ?? true };
    },
    stop: () => Promise.resolve(),
    push: (s) => push?.(s),
  };
  return source;
}
const main = { us: 50_000_000 };

describe('cursor mapping', () => {
  it('maps a monitor (and a record-time crop) into video pixels', () => {
    const m = monitorMapping({
      display: { x: 1920, y: 0, width: 2560, height: 1440 },
      frame: { width: 1280, height: 720 },
      crop: null,
    });
    expect(m).toMatchObject({ originX: 1920, scaleX: 0.5, width: 1280, height: 720 });
    const cropped = monitorMapping({
      display: { x: 0, y: 0, width: 1920, height: 1080 },
      frame: { width: 1920, height: 1080 },
      crop: { x: 100, y: 50, width: 800, height: 600 },
    });
    expect(cropped).toMatchObject({ originX: 100, originY: 50, width: 800, height: 600 });
  });

  it('puts the display in the source’s coordinate space', () => {
    const display = { id: 1, bounds: { x: 100, y: 0, width: 1280, height: 800 }, scaleFactor: 2 };
    expect(displayRect(display, 'dip', 'darwin')).toEqual(display.bounds);
    expect(displayRect(display, 'physical', 'linux')).toEqual({
      x: 200,
      y: 0,
      width: 2560,
      height: 1600,
    });
    const dipToScreenRect = vi.fn(() => ({ x: 7, y: 8, width: 9, height: 10 }));
    expect(displayRect(display, 'physical', 'win32', dipToScreenRect)).toEqual({
      x: 7,
      y: 8,
      width: 9,
      height: 10,
    });
  });

  it('finds the clock offset from back-to-back readings', () => {
    let t = 0;
    const offset = clockOffsetUs(
      () => (t += 10),
      () => 1_000_000 + t,
    );
    expect(Math.abs(offset - 1_000_000)).toBeLessThan(10);
  });
});

describe('cursor recorder (R3.7–R3.9)', () => {
  it('writes session-time samples in video pixels, dropping those before t0', async () => {
    const source = fakeSource();
    const file = path.join(dir, 'cursor.jsonl');
    const recorder = new CursorRecorder({
      source,
      file,
      mapping: monitorMapping({
        display: { x: 0, y: 0, width: 1920, height: 1080 },
        frame: { width: 960, height: 540 },
        crop: null,
      }),
      t0Us: main.us + 100_000,
      mainNowUs: () => main.us,
      sampleRateHz: 120,
      logger,
    });
    expect(recorder.start()).toEqual({ clicks: true });
    // Source time + 1 s = main time; t0 is main + 0.1 s.
    source.push([
      { tUs: main.us - 1_000_000, x: 10, y: 10, action: 'move' },
      { tUs: main.us - 850_000, x: 200, y: 100, action: 'move' },
      { tUs: main.us - 800_000, x: 400, y: 300, action: 'down', button: 'left' },
      { tUs: main.us - 790_000, x: 400, y: 300, action: 'up', button: 'left' },
    ]);
    const result = await recorder.stop();
    expect(result).toMatchObject({ samples: 3, clicks: 1, clicksAvailable: true });
    const track = parseCursorTrack(await fs.readFile(file, 'utf8'));
    expect(track.header).toEqual({ sampleRateHz: 120, width: 960, height: 540 });
    expect(Array.from(track.t)).toEqual([50_000, 100_000, 110_000]);
    expect(Array.from(track.x)).toEqual([100, 200, 200]);
    expect(track.clicks).toEqual([{ tUs: 100_000, x: 200, y: 150, button: 'left', upUs: 110_000 }]);
  });

  it('writes nothing when the source cannot start', async () => {
    const file = path.join(dir, 'cursor.jsonl');
    const recorder = new CursorRecorder({
      source: fakeSource({ fail: true }),
      file,
      mapping: monitorMapping({
        display: { x: 0, y: 0, width: 100, height: 100 },
        frame: { width: 100, height: 100 },
        crop: null,
      }),
      t0Us: 0,
      mainNowUs: () => main.us,
      sampleRateHz: 120,
      logger,
    });
    expect(() => recorder.start()).toThrow('no display');
    expect(await recorder.stop()).toBeNull();
    await expect(fs.access(file)).rejects.toThrow();
  });

  it('keeps samples a polling source delivers during start', async () => {
    const file = path.join(dir, 'cursor.jsonl');
    const recorder = new CursorRecorder({
      source: pollingCursorSource(
        {
          point: () => ({ x: 5, y: 6 }),
          nowUs: () => main.us,
          setInterval: () => 1,
          clearInterval: () => undefined,
        },
        120,
      ),
      file,
      mapping: monitorMapping({
        display: { x: 0, y: 0, width: 100, height: 100 },
        frame: { width: 100, height: 100 },
        crop: null,
      }),
      t0Us: main.us - 10,
      mainNowUs: () => main.us,
      sampleRateHz: 120,
      logger,
    });
    expect(recorder.start()).toEqual({ clicks: false });
    expect(await recorder.stop()).toMatchObject({ samples: 1, source: 'poll' });
    expect(parseCursorTrack(await fs.readFile(file, 'utf8')).t).toHaveLength(1);
  });
});

describe('cursor sources', () => {
  it('decodes helper batches', () => {
    expect(decodeBatch([1, 2, 3, 0, 0, 4, 5, 6, 1, 3])).toEqual([
      { tUs: 1, x: 2, y: 3, action: 'move' },
      { tUs: 4, x: 5, y: 6, action: 'down', button: 'right' },
    ]);
  });

  it('waits for the helper’s end batch when stopping', async () => {
    let callback: ((batch: number[]) => void) | null = null;
    const helper = {
      backend: () => 'x11' as const,
      coordinateSpace: () => 'physical' as const,
      monotonicUs: () => 0,
      startCursor: (_rate: number, cb: (batch: number[]) => void) => {
        callback = cb;
        return { clicks: true };
      },
      stopCursor: () => {
        setTimeout(() => {
          callback?.([9, 1, 1, 2, 1]);
          callback?.([]);
        }, 5);
      },
      listWindows: () => [],
      foregroundWindow: () => null,
      injectPointer: () => undefined,
    };
    const source = nativeCursorSource(helper, 120);
    const got: RawCursorSample[] = [];
    source.start((s) => got.push(...s));
    await source.stop();
    expect(got).toEqual([{ tUs: 9, x: 1, y: 1, action: 'up', button: 'left' }]);
  });
});

describe('cursor track start', () => {
  const display = { id: 7, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };
  const source = {
    sourceId: 'screen:7:0',
    displayId: '7',
    maxWidth: 1920,
    maxHeight: 1080,
    kind: 'monitor' as const,
    widthPx: 1920,
    heightPx: 1080,
  };

  it('falls back to polling when the helper refuses, and records nothing where unavailable', async () => {
    const deps = {
      helper: {
        backend: () => 'x11' as const,
        coordinateSpace: () => 'physical' as const,
        monotonicUs: () => 0,
        startCursor: () => {
          throw new Error('cannot open the X display');
        },
        stopCursor: () => undefined,
        listWindows: () => [],
        foregroundWindow: () => null,
        injectPointer: () => undefined,
      },
      available: () => true,
      displays: () => [display],
      primaryDisplay: () => display,
      cursorPoint: () => ({ x: 1, y: 1 }),
      platform: 'linux' as const,
      mainNowUs: () => main.us,
      logger,
    };
    const start = createCursorTrackStarter(deps);
    const file = path.join(dir, 'cursor.jsonl');
    const recording = start({ file, source, crop: null, t0Us: main.us - 1 });
    expect(await recording?.stop()).toMatchObject({ source: 'poll', clicksAvailable: false });
    expect(
      createCursorTrackStarter({ ...deps, available: () => false })({
        file,
        source,
        crop: null,
        t0Us: 0,
      }),
    ).toBeNull();
  });
});

describe('native helper loading', () => {
  it('finds the build for the platform and says why it is missing', () => {
    const options = { isPackaged: false, resourcesPath: '/r', appPath: '/app' };
    expect(nativeHelperPath({ ...options, platform: 'linux', arch: 'x64' })).toBe(
      '/app/resources/native/linux-x64/cs-native.node',
    );
    expect(
      nativeHelperPath({ ...options, isPackaged: true, platform: 'darwin', arch: 'arm64' }),
    ).toBe('/r/native/darwin-arm64/cs-native.node');
    expect(nativeHelperPath({ ...options, env: { CS_NATIVE_DIR: '/n' } })).toBe(
      '/n/cs-native.node',
    );
    expect(
      loadNativeHelper(
        options,
        () => ({}),
        () => false,
      ),
    ).toMatchObject({
      helper: null,
      reason: expect.stringMatching(/build:native/) as unknown,
    });
    expect(
      loadNativeHelper(
        options,
        () => {
          throw new Error('wrong ELF class');
        },
        () => true,
      ),
    ).toMatchObject({ helper: null, reason: expect.stringMatching(/wrong ELF class/) as unknown });
  });
});

describe('cursor media in the project', () => {
  it('adds a valid cursor media for the screen', () => {
    const doc = exampleProject();
    const result = {
      samples: 10,
      clicks: 2,
      durationUs: 5_000_000,
      sampleRateHz: 120,
      clicksAvailable: true,
      source: 'native' as const,
    };
    const withTrack = withCursorMedia(doc, result, 4_000_000);
    const cursor = withTrack.media.at(-1);
    expect(cursor).toMatchObject({
      role: 'cursor',
      kind: 'cursor',
      path: 'media/cursor.jsonl',
      durationUs: 5_000_000,
      cursor: { screenMediaId: 'med_s', inVideo: true, samples: 10, clicks: 2 },
    });
    expect(checkProjectInvariants(withTrack)).toEqual([]);
    expect(withCursorMedia(doc, null, 1)).toBe(doc);
  });
});
