/**
 * Screen beautify and camera zoom/pan (R2.9, R2.11): the camera keyframe model, the timeline
 * operations (clamping, refusals, cuts), the background gradient the compositor draws, the
 * inspector's operations and the timeline's zoom keyframe lane.
 */
import { describe, expect, it, vi } from 'vitest';
import { runCommand, type CommandContext } from '../../src/renderer/editor/commands';
import {
  backgroundCss,
  beautifyOp,
  cameraEditOp,
  cameraStateAt,
  cameraZoomOp,
  gradientOf,
  plainBackgroundOp,
} from '../../src/renderer/editor/InspectorPanel/screen-style-ops';
import { gradientAxis, gradientT } from '../../src/renderer/editor/preview/compositor-math';
import { createDocumentStore } from '../../src/renderer/editor/store/document-store';
import {
  KEYFRAME_LANE_PX,
  hitTest,
  layoutRows,
  moveKeyframeOp,
  rowKeyframes,
  timeToX,
} from '../../src/renderer/editor/Timeline/geometry';
import { createUiStore } from '../../src/renderer/editor/ui-store';
import { DEFAULT_BEAUTIFY } from '../../src/shared/project/beautify';
import {
  CAMERA_ZOOM_MAX,
  cameraAt,
  cameraRect,
  cameraView,
  cameraZoomRange,
  clampCameraRect,
  FULL_CAMERA,
  upsertCameraKeyframe,
} from '../../src/shared/project/camera-keyframes';
import { applyCamera, sceneAt } from '../../src/shared/project/scene';
import type { CameraKeyframe, Project } from '../../src/shared/project/schema';
import { applyOp, type TimelineOp } from '../../src/shared/project/timeline-ops';
import { unwrap } from '../../src/shared/result';
import { counterIds, recordedProject, trackByName } from '../fixtures/editor-project';

const S = 1_000_000;

function project(): Project {
  return recordedProject({
    durationUs: 20 * S,
    pauses: [],
    system: false,
    screenSize: { width: 1280, height: 720 },
    cameraSize: { width: 640, height: 480 },
    offsets: { screen: 0, camera: 0, microphone: 0 },
  });
}

const run = (doc: Project, ...ops: (TimelineOp | null)[]) =>
  ops.reduce((d, op) => unwrap(applyOp(d, op!, { generateId: counterIds('C') })), doc);

const ZOOM2 = cameraRect(2, 0.25, 0.25);

describe('camera rects', () => {
  it('keep the canvas aspect and stay inside it', () => {
    expect(cameraRect(2, 0.5, 0.5)).toEqual({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
    expect(cameraRect(2, 0.95, 0.05)).toEqual({ x: 0.5, y: 0, width: 0.5, height: 0.5 });
    expect(cameraRect(0.5, 0.2, 0.2)).toEqual(FULL_CAMERA);
    expect(cameraRect(10, 0.5, 0.5).width).toBe(1 / CAMERA_ZOOM_MAX);
    expect(cameraView(cameraRect(3, 0.4, 0.6))).toEqual({
      zoom: 3,
      centerX: expect.closeTo(0.4, 9) as number,
      centerY: expect.closeTo(0.6, 9) as number,
    });
  });

  it('are clamped by the operations, or refused when not numbers', () => {
    expect(clampCameraRect({ x: 0.9, y: -0.2, width: 0.5, height: 0.05 })).toEqual({
      x: 0.5,
      y: 0,
      width: 0.5,
      height: 0.25,
    });
    expect(clampCameraRect({ x: Number.NaN, y: 0, width: 1, height: 1 })).toBeNull();
  });
});

describe('camera keyframes', () => {
  it('add a full-frame anchor at 0 for the first keyframe later than 0', () => {
    const keys = upsertCameraKeyframe(undefined, 5 * S, { rect: ZOOM2 });
    expect(keys).toEqual([
      { tUs: 0, rect: FULL_CAMERA, easing: 'hold' },
      { tUs: 5 * S, rect: ZOOM2, easing: 'ease-in-out' },
    ]);
    expect(cameraAt(keys, 4 * S)).toEqual(FULL_CAMERA);
    expect(cameraAt(keys, 6 * S)).toEqual(ZOOM2);
  });

  it('start a new keyframe from the rect shown, so adding one changes nothing', () => {
    const keys: CameraKeyframe[] = [
      { tUs: 0, rect: FULL_CAMERA, easing: 'linear' },
      { tUs: 2 * S, rect: ZOOM2, easing: 'hold' },
    ];
    const added = upsertCameraKeyframe(keys, S, {});
    for (const t of [0, 0.5 * S, S, 1.5 * S, 3 * S]) {
      expect(cameraAt(added, t).width).toBeCloseTo(cameraAt(keys, t).width, 9);
    }
  });

  it('zoom a range: eased in before it, held, eased out to what was shown after', () => {
    const keys = cameraZoomRange(undefined, 4 * S, 8 * S, ZOOM2, 0.5 * S);
    expect(keys.map((k) => [k.tUs / S, k.rect.width, k.easing])).toEqual([
      [3.5, 1, 'ease-in-out'],
      [4, 0.5, 'hold'],
      [7.5, 0.5, 'ease-in-out'],
      [8, 1, 'hold'],
    ]);
    expect(cameraAt(keys, 3.75 * S).width).toBeCloseTo(0.75, 9);
    expect(cameraAt(keys, 6 * S)).toEqual(ZOOM2);
    expect(cameraAt(keys, 9 * S)).toEqual(FULL_CAMERA);
    // A cut (no ease) at 0 needs no lead keyframe.
    expect(cameraZoomRange(undefined, 0, 2 * S, ZOOM2, 0).map((k) => k.tUs)).toEqual([0, 2 * S]);
  });

  it('pan a held zoom as one shot', () => {
    const keys = cameraZoomRange(undefined, 4 * S, 8 * S, ZOOM2, 0.5 * S);
    const moved = cameraRect(2, 0.7, 0.5);
    const panned = upsertCameraKeyframe(keys, 4 * S, { rect: moved });
    expect(panned.map((k) => k.rect)).toEqual([FULL_CAMERA, moved, moved, FULL_CAMERA]);
    // The keyframe before the range is not part of it.
    const before = upsertCameraKeyframe(keys, 3.5 * S, { rect: moved });
    expect(before.map((k) => k.rect)).toEqual([moved, ZOOM2, ZOOM2, FULL_CAMERA]);
  });
});

describe('camera and beautify operations', () => {
  it('zoom a range and resolve the camera in the scene (acceptance b)', () => {
    const doc = run(project(), {
      type: 'setCameraZoom',
      startUs: 4 * S,
      endUs: 8 * S,
      rect: ZOOM2,
      easeUs: 0.5 * S,
    });
    const scene = sceneAt(doc, 6 * S);
    expect(scene.camera).toEqual(ZOOM2);
    const screen = scene.layers.find((l) => l.trackId === trackByName(doc, 'Screen').id)!;
    // Zoom 2 on the top-left quarter: the 1280×720 screen becomes 2560×1440 from the origin.
    expect(screen.destRect).toEqual({ x: 0, y: 0, width: 2560, height: 1440 });
    // The face overlay is not zoomed.
    const face = (d: Project, t: number) =>
      sceneAt(d, t).layers.find((l) => l.trackId === trackByName(d, 'Face').id)!.destRect;
    expect(face(doc, 6 * S)).toEqual(face(project(), 6 * S));
  });

  it('refuse bad ranges and long changes, and say when there is nothing to remove', () => {
    const doc = project();
    const zoom = (startUs: number, endUs: number, easeUs = 0): TimelineOp => ({
      type: 'setCameraZoom',
      startUs,
      endUs,
      rect: ZOOM2,
      easeUs,
    });
    expect(applyOp(doc, zoom(5 * S, 2 * S))).toMatchObject({ error: { code: 'invalid-value' } });
    expect(applyOp(doc, zoom(0, 5 * S, 3 * S))).toMatchObject({ error: { code: 'invalid-value' } });
    expect(
      applyOp(doc, { type: 'setCameraKeyframe', tUs: S, rect: { ...ZOOM2, x: Number.NaN } }),
    ).toMatchObject({ error: { code: 'invalid-value' } });
    expect(applyOp(doc, { type: 'removeCameraKeyframe', tUs: S })).toMatchObject({
      error: { code: 'nothing-to-do' },
    });
    const keyed = run(doc, zoom(2 * S, 4 * S));
    expect(
      applyOp(keyed, { type: 'moveCameraKeyframe', fromUs: 2 * S, toUs: 4 * S }),
    ).toMatchObject({ error: { code: 'overlap' } });
    expect(applyOp(doc, plainBackgroundOp())).toMatchObject({ error: { code: 'nothing-to-do' } });
  });

  it('remove the camera field with the last keyframe', () => {
    const doc = run(project(), { type: 'setCameraKeyframe', tUs: 0, rect: ZOOM2 });
    expect(doc.timeline.camera).toHaveLength(1);
    const cleared = run(doc, { type: 'removeCameraKeyframe', tUs: 0 });
    expect(cleared.timeline.camera).toBeUndefined();
  });

  it('move camera keyframes with a cut', () => {
    const doc = run(project(), {
      type: 'setCameraZoom',
      startUs: 10 * S,
      endUs: 14 * S,
      rect: ZOOM2,
      easeUs: 0,
    });
    const cut = run(doc, { type: 'cutRange', inUs: 2 * S, outUs: 5 * S });
    // The 1 µs lead keyframe holds the full frame up to the cut-in zoom.
    expect(cut.timeline.camera?.map((k) => k.tUs / S)).toEqual([6.999999, 7, 11]);
    expect(cameraAt(cut.timeline.camera, 8 * S)).toEqual(ZOOM2);
  });

  it('clamp beautify sizes to the schema ranges', () => {
    const doc = run(project(), {
      type: 'setBeautify',
      beautify: {
        background: { type: 'gradient', from: '#000000', to: '#FFFFFF', angleDeg: 400 },
        padding: 0.9,
        cornerRadius: -1,
        shadow: { blur: 1, offsetX: -1, offsetY: 0.05, color: '#00000080' },
      },
    });
    expect(doc.timeline.beautify).toEqual({
      background: { type: 'gradient', from: '#000000', to: '#FFFFFF', angleDeg: 360 },
      padding: 0.3,
      cornerRadius: 0,
      shadow: { blur: 0.1, offsetX: -0.1, offsetY: 0.05, color: '#00000080' },
    });
  });

  it('lay the screen out inside the padding with rounded corners and a shadow', () => {
    const doc = run(project(), beautifyOp(project(), {}));
    const screen = sceneAt(doc, S).layers.find((l) => l.kind !== 'overlay')!;
    const pad = DEFAULT_BEAUTIFY.padding * 720;
    expect(screen.destRect.x).toBeGreaterThanOrEqual(Math.floor(pad));
    expect(screen.destRect.y).toBeGreaterThanOrEqual(Math.floor(pad));
    expect(screen.destRect.y + screen.destRect.height).toBeLessThanOrEqual(720 - Math.floor(pad));
    expect(screen.mask).toEqual({
      shape: 'rounded',
      radiusPx: DEFAULT_BEAUTIFY.cornerRadius * 720,
    });
    expect(screen.shadow).not.toBeNull();
    expect(sceneAt(doc, S).background).toEqual(DEFAULT_BEAUTIFY.background);
  });
});

describe('background gradient (compositor)', () => {
  const canvas = { width: 1280, height: 720 };

  it('runs the CSS way: 90° left to right, 180° top to bottom, corners at the ends', () => {
    expect(gradientT(90, canvas, 0, 360)).toBeCloseTo(0, 9);
    expect(gradientT(90, canvas, 1280, 360)).toBeCloseTo(1, 9);
    expect(gradientT(180, canvas, 640, 0)).toBeCloseTo(0, 9);
    expect(gradientT(0, canvas, 640, 0)).toBeCloseTo(1, 9);
    // 135°: top-left corner is the start, bottom-right the end, the centre halfway.
    expect(gradientT(135, canvas, 0, 0)).toBeCloseTo(0, 9);
    expect(gradientT(135, canvas, 1280, 720)).toBeCloseTo(1, 9);
    expect(gradientT(135, canvas, 640, 360)).toBeCloseTo(0.5, 9);
    expect(gradientAxis(45, canvas).length).toBeCloseTo((1280 + 720) * Math.SQRT1_2, 6);
  });
});

describe('inspector: background and zoom', () => {
  it('starts from the default style and merges each change', () => {
    const doc = project();
    expect(beautifyOp(doc, { padding: 0.1 })).toEqual({
      type: 'setBeautify',
      beautify: { ...DEFAULT_BEAUTIFY, padding: 0.1 },
    });
    const styled = run(doc, beautifyOp(doc, { shadow: null }));
    expect(styled.timeline.beautify?.shadow).toBeUndefined();
    expect(beautifyOp(styled, { cornerRadius: 0.05 })).toMatchObject({
      beautify: { padding: DEFAULT_BEAUTIFY.padding, cornerRadius: 0.05 },
    });
    expect(gradientOf({ type: 'color', color: '#112233' }, { to: '#FFFFFF' })).toEqual({
      type: 'gradient',
      from: '#112233',
      to: '#FFFFFF',
      angleDeg: 135,
    });
    expect(backgroundCss(DEFAULT_BEAUTIFY.background)).toBe(
      'linear-gradient(135deg, #4F46E5, #DB2777)',
    );
  });

  it('zooms the In–Out range, or the keyframe at the playhead', () => {
    const doc = project();
    expect(cameraZoomOp(doc, 3 * S, 2, 600_000)).toEqual({
      type: 'setCameraKeyframe',
      tUs: 3 * S,
      rect: cameraRect(2, 0.5, 0.5),
    });
    const marked = run(doc, { type: 'setMarks', inUs: 2 * S, outUs: 6 * S });
    expect(cameraZoomOp(marked, 3 * S, 2, 600_000)).toEqual({
      type: 'setCameraZoom',
      startUs: 2 * S,
      endUs: 6 * S,
      rect: cameraRect(2, 0.5, 0.5),
      easeUs: 600_000,
    });
  });

  it('edits the zoom keyframe in effect at the playhead', () => {
    const doc = run(project(), {
      type: 'setCameraZoom',
      startUs: 4 * S,
      endUs: 8 * S,
      rect: ZOOM2,
      easeUs: 0.5 * S,
    });
    expect(cameraStateAt(doc, 6 * S)).toMatchObject({ zoom: 2, keyTime: 4 * S });
    const op = cameraEditOp(doc, 6 * S, { centerX: 0.6 });
    expect(op).toEqual({ type: 'setCameraKeyframe', tUs: 4 * S, rect: cameraRect(2, 0.6, 0.25) });
    const panned = run(doc, op);
    expect(cameraAt(panned.timeline.camera, 7 * S)).toEqual(cameraRect(2, 0.6, 0.25));
    expect(cameraStateAt(project(), S)).toEqual({
      zoom: 1,
      centerX: 0.5,
      centerY: 0.5,
      keyTime: null,
    });
  });
});

describe('timeline zoom keyframe lane', () => {
  const zoomed = () =>
    run(project(), { type: 'setCameraZoom', startUs: 4 * S, endUs: 8 * S, rect: ZOOM2 });

  it('shows camera keyframes on the screen row and hits them there', () => {
    const doc = zoomed();
    const { rows } = layoutRows(doc);
    const screenRow = rows.find((r) => r.track.name === 'Screen')!;
    expect(rowKeyframes(screenRow)).toEqual([3_999_999, 4 * S, 8 * S]);
    const view = { pxPerSec: 20, scrollUs: 0 };
    const laneY = screenRow.top + screenRow.height - KEYFRAME_LANE_PX / 2;
    expect(hitTest(rows, view, timeToX(view, 8 * S) + 2, laneY)).toMatchObject({
      kind: 'keyframe',
      lane: 'camera',
      keyUs: 8 * S,
    });
    expect(
      moveKeyframeOp({ lane: 'camera', trackId: screenRow.track.id, tUs: 8 * S }, 9 * S),
    ).toEqual({ type: 'moveCameraKeyframe', fromUs: 8 * S, toUs: 9 * S });
  });

  it('deletes the selected zoom keyframe with Delete (one undo step)', () => {
    const docStore = createDocumentStore({ opOptions: { generateId: counterIds('D') } });
    const doc = zoomed();
    docStore.getState().load({ doc, revision: 0, mediaUrls: {}, readOnly: false });
    const ui = createUiStore();
    const transport = {
      toggle: vi.fn(),
      shuttle: vi.fn(),
      step: vi.fn(),
      home: vi.fn(),
      end: vi.fn(),
    };
    const ctx: CommandContext = { docStore, ui, transport, timelineWidth: () => 800 };
    ui.getState().selectKeyframe({
      lane: 'camera',
      trackId: trackByName(doc, 'Screen').id,
      tUs: 8 * S,
    });
    runCommand('delete', ctx);
    expect(docStore.getState().doc!.timeline.camera?.map((k) => k.tUs)).toEqual([3_999_999, 4 * S]);
    expect(docStore.getState().undoLabel).toBe('Delete zoom keyframe');
    runCommand('undo', ctx);
    expect(docStore.getState().doc).toEqual(doc);
  });
});

describe('applyCamera', () => {
  it('maps canvas pixels through the camera rect', () => {
    expect(
      applyCamera({ x: 320, y: 180, width: 64, height: 36 }, ZOOM2, { width: 1280, height: 720 }),
    ).toEqual({ x: 640, y: 360, width: 128, height: 72 });
  });
});
