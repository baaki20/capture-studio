/**
 * Annotation objects (R2.5–R2.8): defaults and labels, the draw plan, the object operations
 * (checks, patches, motion keyframes, cuts, locked tracks), the compositor's blur and pixelate
 * maths, text wrapping, the editor's annotation operations and the timeline's object rows.
 */
import { describe, expect, it, vi } from 'vitest';
import { runCommand, type CommandContext } from '../../src/renderer/editor/commands';
import {
  addObjectOp,
  boxFromFrameRect,
  objectAt,
  objectBoxOp,
} from '../../src/renderer/editor/InspectorPanel/annotation-ops';
import { blurWeights, pixelateSample } from '../../src/renderer/editor/preview/compositor-math';
import { createDocumentStore } from '../../src/renderer/editor/store/document-store';
import {
  OBJECT_LANE_PX,
  OBJECT_ROW_HEIGHT,
  RULER_HEIGHT,
  hitTest,
  layoutRows,
  objectBarTop,
  objectLanes,
  timeToX,
} from '../../src/renderer/editor/Timeline/geometry';
import { createUiStore } from '../../src/renderer/editor/ui-store';
import { cameraRect } from '../../src/shared/project/camera-keyframes';
import {
  OBJECT_KINDS,
  arrowEnds,
  newObject,
  objectDrawPlan,
  objectLabel,
  sceneObjectPlans,
  stepLabel,
  wrapLines,
} from '../../src/shared/project/objects';
import { applyCamera, sceneAt } from '../../src/shared/project/scene';
import type { Project, TimelineObject } from '../../src/shared/project/schema';
import { TimelineObjectSchema } from '../../src/shared/project/schema';
import { applyOp, type TimelineOp } from '../../src/shared/project/timeline-ops';
import { unwrap } from '../../src/shared/result';
import { counterIds, recordedProject } from '../fixtures/editor-project';

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
  ops.reduce((d, op) => unwrap(applyOp(d, op!, { generateId: counterIds('O') })), doc);

const items = (doc: Project) => doc.timeline.objectTracks?.flatMap((t) => t.items) ?? [];

describe('object defaults and labels', () => {
  it('makes a valid object of every kind', () => {
    for (const kind of OBJECT_KINDS) {
      const item = newObject(kind, 'obj_A1', 0, S);
      expect(TimelineObjectSchema.safeParse(item).success, kind).toBe(true);
      expect(item.kind).toBe(kind);
    }
  });

  it('labels steps in each format', () => {
    expect([1, 26, 27, 52].map((n) => stepLabel(n, 'A'))).toEqual(['A', 'Z', 'AA', 'AZ']);
    expect(stepLabel(3, 'a')).toBe('c');
    expect(stepLabel(4, 'I')).toBe('IV');
    expect(stepLabel(1994, 'i')).toBe('mcmxciv');
    expect(stepLabel(12, '1')).toBe('12');
    expect(objectLabel({ ...newObject('text', 'obj_A1', 0, S), text: '\n' })).toBe('Text');
    expect(objectLabel({ ...newObject('text', 'obj_A1', 0, S), text: 'Hi\nthere' })).toBe('Hi');
  });

  it('points arrows from the tail corner to the opposite one', () => {
    expect(arrowEnds('bottom-left', 100, 50)).toEqual({ from: [0, 50], to: [100, 0] });
    expect(arrowEnds('top-right', 100, 50)).toEqual({ from: [100, 0], to: [0, 50] });
  });
});

describe('draw plan', () => {
  const canvas = { width: 1280, height: 720 };
  const scene = (
    item: TimelineObject,
    rectPx = { x: 100.25, y: 50.5, width: 300, height: 80 },
  ) => ({
    trackId: 'trk_A',
    item,
    box: item.box,
    rectPx,
    opacity: 1,
  });

  it('places pictures on whole pixels and keeps the key when only the place changes', () => {
    const text = newObject('text', 'obj_A1', 0, S);
    const a = objectDrawPlan(scene(text), canvas);
    const b = objectDrawPlan(scene(text, { x: 110.25, y: 70.5, width: 300, height: 80 }), canvas);
    if (a.kind !== 'raster' || b.kind !== 'raster') throw new Error('raster expected');
    expect(a.rect).toEqual({ x: 100, y: 50, width: 301, height: 81 });
    expect(a.inner).toEqual({ x: 0.25, y: 0.5, width: 300, height: 80 });
    expect(a.unitPx).toBe(720);
    expect(b.key).toBe(a.key);
    const recoloured = { ...text, style: { ...text.style, color: '#000000' } };
    const c = objectDrawPlan(scene(recoloured), canvas);
    expect(c.kind === 'raster' && c.key).not.toBe(a.key);
  });

  it('gives arrows room for the head and spotlights the whole frame', () => {
    const arrow = objectDrawPlan(scene(newObject('arrow', 'obj_A1', 0, S)), canvas);
    expect(arrow.kind === 'raster' && arrow.rect.x).toBeLessThan(100);
    const spot = objectDrawPlan(scene(newObject('spotlight', 'obj_A1', 0, S)), canvas);
    expect(spot.kind === 'raster' && spot.rect).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
    expect(spot.kind === 'raster' && spot.inner).toEqual({
      x: 100.25,
      y: 50.5,
      width: 300,
      height: 80,
    });
  });

  it('sizes blur and pixelate in output pixels, zoom included', () => {
    const blur = { ...newObject('blur', 'obj_A1', 0, S), radius: 0.01 };
    expect(objectDrawPlan(scene(blur), canvas)).toMatchObject({ kind: 'blur', radiusPx: 7.2 });
    expect(objectDrawPlan(scene(blur), canvas, 2)).toMatchObject({ radiusPx: 14.4 });
    const pix = { ...newObject('pixelate', 'obj_A1', 0, S), blockSize: 0.02 };
    expect(objectDrawPlan(scene(pix), canvas)).toMatchObject({ kind: 'pixelate', blockPx: 14.4 });
  });

  it('follows the camera: an object zooms with the screen', () => {
    const doc = run(
      project(),
      { type: 'addObject', item: newObject('rectangle', 'obj_A1', 0, 10 * S) },
      { type: 'setCameraKeyframe', tUs: 0, rect: cameraRect(2, 0.5, 0.5) },
    );
    const s = sceneAt(doc, S);
    const [plan] = sceneObjectPlans(s);
    const rect = applyCamera(
      { x: 0.35 * 1280, y: 0.375 * 720, width: 0.3 * 1280, height: 0.25 * 720 },
      s.camera,
      s.canvas,
    );
    expect(plan?.kind === 'raster' && plan.inner.width).toBeCloseTo(rect.width, 6);
    expect(plan?.kind === 'raster' && plan.unitPx).toBe(1440);
  });
});

describe('object operations', () => {
  const add = (item: TimelineObject): TimelineOp => ({ type: 'addObject', item });

  it('adds to an Annotations track made on demand, and refuses a second object with an ID', () => {
    const doc = run(project(), add(newObject('text', 'obj_A1', S, 3 * S)));
    expect(doc.timeline.objectTracks?.map((t) => t.name)).toEqual(['Annotations']);
    expect(applyOp(doc, add(newObject('blur', 'obj_A1', 0, S)))).toMatchObject({
      error: { code: 'invalid-value' },
    });
    const short = newObject('blur', 'obj_A2', S, S + 10);
    expect(applyOp(doc, add(short))).toMatchObject({ error: { code: 'invalid-value' } });
    // A refused add uses up no generated IDs (batches replay the same ID sequence).
    const ids = vi.fn(counterIds('Z'));
    expect(applyOp(project(), add(short), { generateId: ids }).ok).toBe(false);
    expect(ids).not.toHaveBeenCalled();
  });

  it('patches the fields of the kind, removes with null and merges the text style', () => {
    const doc = run(project(), add({ ...newObject('text', 'obj_A1', 0, 5 * S), fadeInUs: S }));
    const patched = run(doc, {
      type: 'updateObject',
      objectId: 'obj_A1',
      patch: { text: 'New', fadeInUs: null, style: { size: 0.1, outline: null } },
    });
    const item = items(patched)[0];
    if (item?.kind !== 'text') throw new Error('text expected');
    expect(item.text).toBe('New');
    expect(item.fadeInUs).toBeUndefined();
    expect(item.style).toMatchObject({ size: 0.1, font: 'sans', bold: true });
    expect(item.style.outline).toBeUndefined();
    for (const patch of [
      { radius: 0.01 },
      { style: { size: 0.9 } },
      { box: { x: 0, y: 0, width: 2, height: 1 } },
    ]) {
      expect(applyOp(doc, { type: 'updateObject', objectId: 'obj_A1', patch })).toMatchObject({
        error: { code: 'invalid-value' },
      });
    }
  });

  it('moves objects with their keyframes and keeps keyframes inside their times', () => {
    let doc = run(project(), add(newObject('blur', 'obj_A1', 2 * S, 6 * S)));
    doc = run(doc, {
      type: 'setObjectKeyframe',
      objectId: 'obj_A1',
      tUs: 4 * S,
      box: { x: 0.5, y: 0.5, width: 0.2, height: 0.2 },
    });
    // The anchor at the start keeps the box it had.
    expect(items(doc)[0]?.keyframes?.map((k) => [k.tUs / S, k.box.x])).toEqual([
      [2, items(doc)[0]?.box.x],
      [4, 0.5],
    ]);
    expect(
      applyOp(doc, { type: 'setObjectKeyframe', objectId: 'obj_A1', tUs: 7 * S }),
    ).toMatchObject({ error: { code: 'invalid-value' } });
    const moved = run(doc, { type: 'moveObject', objectId: 'obj_A1', toInUs: 5 * S });
    expect(items(moved)[0]).toMatchObject({ inUs: 5 * S, outUs: 9 * S });
    expect(items(moved)[0]?.keyframes?.map((k) => k.tUs / S)).toEqual([5, 7]);
    const trimmed = run(doc, { type: 'updateObject', objectId: 'obj_A1', patch: { inUs: 3 * S } });
    expect(items(trimmed)[0]?.keyframes?.map((k) => k.tUs / S)).toEqual([4]);
    const plain = run(trimmed, { type: 'removeObjectKeyframe', objectId: 'obj_A1', tUs: 4 * S });
    expect(items(plain)[0]?.keyframes).toBeUndefined();
  });

  it('cuts objects with the content, and leaves locked tracks alone', () => {
    let doc = run(
      project(),
      add(newObject('text', 'obj_A1', 2 * S, 3 * S)),
      add(newObject('arrow', 'obj_A2', 6 * S, 8 * S)),
      add(newObject('blur', 'obj_A3', 3 * S, 7 * S)),
    );
    const cut = run(doc, { type: 'cutRange', inUs: S, outUs: 4 * S });
    expect(items(cut).map((i) => [i.id, i.inUs / S, i.outUs / S])).toEqual([
      ['obj_A2', 3, 5],
      ['obj_A3', 1, 4],
    ]);
    const trackId = doc.timeline.objectTracks![0]!.id;
    doc = run(doc, { type: 'setObjectTrack', trackId, locked: true });
    expect(items(run(doc, { type: 'cutRange', inUs: S, outUs: 4 * S }))).toEqual(items(doc));
    expect(applyOp(doc, { type: 'removeObjects', objectIds: ['obj_A1'] })).toMatchObject({
      error: { code: 'track-locked' },
    });
    const hidden = run(doc, { type: 'setObjectTrack', trackId, hidden: true });
    expect(sceneAt(hidden, 2.5 * S).objects).toEqual([]);
  });
});

describe('blur and pixelate maths', () => {
  it('blurs with normalised Gaussian weights reaching the radius', () => {
    const w = blurWeights(9);
    expect(w).toHaveLength(10);
    expect(w.reduce((sum, x, i) => sum + (i === 0 ? x : 2 * x), 0)).toBeCloseTo(1, 9);
    expect(w[0]!).toBeGreaterThan(w[3]!);
    expect(blurWeights(1000)).toHaveLength(129);
  });

  it('samples each block at its centre, inside the region and the frame', () => {
    const rect = { x: 10, y: 10, width: 40, height: 20 };
    const canvas = { width: 64, height: 32 };
    expect(pixelateSample(rect, 10, 10, 10, canvas)).toEqual([15, 15]);
    expect(pixelateSample(rect, 10, 19, 19, canvas)).toEqual([15, 15]);
    expect(pixelateSample(rect, 10, 20, 25, canvas)).toEqual([25, 25]);
    // Blocks cut by the region's edge: the block centre while inside (x), else the edge (y).
    expect(pixelateSample(rect, 15, 49, 29, canvas)).toEqual([47, 29]);
  });
});

describe('text wrapping', () => {
  const measure = { measureText: (s: string) => ({ width: s.length * 10 }) };

  it('wraps at spaces to the width and keeps line breaks', () => {
    expect(wrapLines(measure, 'one two three four', 90)).toEqual(['one two', 'three', 'four']);
    expect(wrapLines(measure, 'a\nb c', 1000)).toEqual(['a', 'b c']);
    expect(wrapLines(measure, 'unbreakablelongword', 50)).toEqual(['unbreakablelongword']);
  });
});

describe('editor annotation operations', () => {
  it('adds at the playhead, shortened at the end, with the next step number', () => {
    const doc = project();
    const op = addObjectOp(doc, 'step', 18.5 * S, 'obj_A1');
    expect(op).toMatchObject({ item: { inUs: 18.5 * S, outUs: 20 * S, value: 1 } });
    const withStep = run(doc, op);
    expect(addObjectOp(withStep, 'step', 0, 'obj_A2')).toMatchObject({ item: { value: 2 } });
    expect(addObjectOp(doc, 'text', 0, 'obj_A3', 'code')).toMatchObject({
      item: { preset: 'code', style: { font: 'mono' } },
    });
  });

  it('edits the box, or the box keyframe at the playhead when it moves', () => {
    let doc = run(project(), { type: 'addObject', item: newObject('blur', 'obj_A1', 0, 10 * S) });
    const box = { x: 0.1, y: 0.1, width: 0.2, height: 0.2 };
    expect(objectBoxOp(doc, 'obj_A1', box, 5 * S)).toEqual({
      type: 'updateObject',
      objectId: 'obj_A1',
      patch: { box },
    });
    doc = run(doc, { type: 'setObjectKeyframe', objectId: 'obj_A1', tUs: 2 * S });
    expect(objectBoxOp(doc, 'obj_A1', box, 12 * S)).toEqual({
      type: 'setObjectKeyframe',
      objectId: 'obj_A1',
      tUs: 10 * S,
      box,
    });
  });

  it('maps a frame rect back through the camera and picks the topmost object', () => {
    let doc = run(project(), { type: 'setCameraKeyframe', tUs: 0, rect: cameraRect(2, 0.5, 0.5) });
    const box = boxFromFrameRect(doc, { x: 640, y: 360, width: 128, height: 72 }, S);
    expect(box.x).toBeCloseTo(0.5, 9);
    expect(box.width).toBeCloseTo(0.05, 9);
    doc = run(
      doc,
      {
        type: 'addObject',
        item: newObject('rectangle', 'obj_A1', 0, 10 * S, {
          x: 0.25,
          y: 0.25,
          width: 0.5,
          height: 0.5,
        }),
      },
      {
        type: 'addObject',
        item: newObject('ellipse', 'obj_A2', 0, 10 * S, {
          x: 0.45,
          y: 0.45,
          width: 0.1,
          height: 0.1,
        }),
      },
    );
    expect(objectAt(doc, S, 640, 360)).toBe('obj_A2');
    expect(objectAt(doc, S, 100, 100)).toBe('obj_A1');
    expect(objectAt(doc, 11 * S, 640, 360)).toBeNull();
  });
});

describe('timeline object rows', () => {
  it('puts object rows on top and hits object bars and their edges', () => {
    const doc = run(project(), {
      type: 'addObject',
      item: newObject('text', 'obj_A1', 2 * S, 6 * S),
    });
    const { rows, objectRows } = layoutRows(doc);
    expect(objectRows[0]?.top).toBe(RULER_HEIGHT + 2);
    expect(rows[0]!.top).toBe(RULER_HEIGHT + 2 + OBJECT_ROW_HEIGHT + 2);
    const view = { pxPerSec: 20, scrollUs: 0 };
    const y = objectRows[0]!.top + 10;
    expect(hitTest(rows, view, timeToX(view, 4 * S), y, objectRows)).toMatchObject({
      kind: 'object',
      objectId: 'obj_A1',
      zone: 'body',
    });
    expect(hitTest(rows, view, timeToX(view, 6 * S) - 1, y, objectRows)).toMatchObject({
      zone: 'end',
    });
    expect(hitTest(rows, view, timeToX(view, 10 * S), y, objectRows).kind).toBe('track');
  });

  it('stacks objects that overlap in time in lanes, each clickable', () => {
    expect([
      ...objectLanes([
        { id: 'a', inUs: 0, outUs: 5 },
        { id: 'b', inUs: 2, outUs: 4 },
        { id: 'c', inUs: 5, outUs: 9 },
        { id: 'd', inUs: 3, outUs: 6 },
      ]),
    ]).toEqual([
      ['a', 0],
      ['b', 1],
      ['d', 2],
      ['c', 0],
    ]);
    const doc = run(
      project(),
      { type: 'addObject', item: newObject('text', 'obj_A1', 0, 4 * S) },
      { type: 'addObject', item: newObject('blur', 'obj_A2', S, 3 * S) },
    );
    const { rows, objectRows } = layoutRows(doc);
    const row = objectRows[0]!;
    expect(row.height).toBe(OBJECT_ROW_HEIGHT + OBJECT_LANE_PX);
    const view = { pxPerSec: 20, scrollUs: 0 };
    const x = timeToX(view, 2 * S);
    expect(hitTest(rows, view, x, objectBarTop(row, 'obj_A1') + 5, objectRows)).toMatchObject({
      objectId: 'obj_A1',
    });
    expect(hitTest(rows, view, x, objectBarTop(row, 'obj_A2') + 5, objectRows)).toMatchObject({
      objectId: 'obj_A2',
    });
  });

  it('deletes the selected object with Delete (one undo step)', () => {
    const docStore = createDocumentStore({ opOptions: { generateId: counterIds('D') } });
    const doc = run(project(), { type: 'addObject', item: newObject('blur', 'obj_A1', 0, S) });
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
    ui.getState().selectObject('obj_A1');
    runCommand('delete', ctx);
    expect(items(docStore.getState().doc!)).toEqual([]);
    expect(ui.getState().selectedObject).toBeNull();
    expect(docStore.getState().undoLabel).toBe('Delete annotation');
    runCommand('undo', ctx);
    expect(docStore.getState().doc).toEqual(doc);
  });
});
