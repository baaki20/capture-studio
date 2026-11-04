/**
 * Face layout over time in the editor (R2.1–R2.4): which keyframe face edits change, face mode
 * over the In–Out marks or from the playhead, style ops, the preview's draggable face box, the
 * timeline keyframe lane (hit testing) and Delete on a selected keyframe.
 */
import { describe, expect, it, vi } from 'vitest';
import { runCommand, type CommandContext } from '../../src/renderer/editor/commands';
import {
  addKeyframeOp,
  alphaOf,
  borderOp,
  cornerOp,
  faceBoxAt,
  faceLayoutAt,
  faceModeOp,
  faceTrack,
  overlayRectOp,
  shapeOp,
  sizeOp,
  withAlpha,
  zoomOp,
} from '../../src/renderer/editor/InspectorPanel/inspector-ops';
import { createDocumentStore } from '../../src/renderer/editor/store/document-store';
import {
  KEYFRAME_LANE_PX,
  hitTest,
  layoutRows,
  timeToX,
} from '../../src/renderer/editor/Timeline/geometry';
import { createUiStore } from '../../src/renderer/editor/ui-store';
import { sceneAt } from '../../src/shared/project/scene';
import type { Project } from '../../src/shared/project/schema';
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
  ops.reduce((d, op) => unwrap(applyOp(d, op!, { generateId: counterIds('E') })), doc);

/** A project whose face goes full screen from 5 s to 8 s (hard cuts). */
function keyed(): Project {
  const doc = project();
  const id = faceTrack(doc)!.id;
  return run(doc, { type: 'setFaceMode', trackId: id, startUs: 5 * S, endUs: 8 * S, mode: 'full' });
}

describe('face edits with keyframes', () => {
  it('changes the static layout when there are no keyframes', () => {
    const doc = project();
    const id = faceTrack(doc)!.id;
    expect(sizeOp(doc, id, 0.3, 7 * S)).toEqual({
      type: 'setLayout',
      trackId: id,
      layout: { width: 0.3 },
    });
  });

  it('sends geometry to the keyframe in effect at the playhead, style to the whole track', () => {
    const doc = keyed();
    const id = faceTrack(doc)!.id;
    const keys = faceTrack(doc)!.layoutKeyframes!;
    const before = keys.find((k) => k.tUs < 5 * S)!;
    expect(sizeOp(doc, id, 0.3, 2 * S)).toEqual({
      type: 'setLayoutKeyframe',
      trackId: id,
      tUs: before.tUs,
      layout: { width: 0.3 },
    });
    expect(cornerOp(doc, id, 'top-left', 6 * S)).toMatchObject({
      type: 'setLayoutKeyframe',
      tUs: 5 * S,
    });
    expect(overlayRectOp(doc, id, { x: 0, y: 0, width: 200, height: 150 }, 9 * S)).toMatchObject({
      type: 'setLayoutKeyframe',
      tUs: 8 * S,
    });
    expect(shapeOp(id, 'circle')).toMatchObject({ type: 'setLayout' });
    expect(zoomOp(id, 2)).toEqual({ type: 'setLayout', trackId: id, layout: { zoom: 2 } });
    expect(borderOp(id, null)).toEqual({
      type: 'setLayout',
      trackId: id,
      layout: { border: null },
    });

    // Resizing at 2 s changes only the overlay before the segment.
    const resized = run(doc, sizeOp(doc, id, 0.3, 2 * S));
    expect(faceLayoutAt(resized, id, 2 * S)?.layout.width).toBe(0.3);
    expect(faceLayoutAt(resized, id, 9 * S)?.layout.width).toBe(faceTrack(doc)!.layout.width);
  });

  it('shows the mode and layout in effect at the playhead', () => {
    const doc = keyed();
    const id = faceTrack(doc)!.id;
    expect(faceLayoutAt(doc, id, 2 * S)?.mode).toBe('overlay');
    expect(faceLayoutAt(doc, id, 6 * S)).toMatchObject({ mode: 'full', keyTime: 5 * S });
  });
});

describe('face mode and keyframe controls (R2.2)', () => {
  it('uses the In–Out range when both marks are set, the playhead otherwise', () => {
    const doc = project();
    const id = faceTrack(doc)!.id;
    expect(faceModeOp(doc, id, 'hidden', 3 * S, 300_000)).toEqual({
      type: 'setLayoutKeyframe',
      trackId: id,
      tUs: 3 * S,
      mode: 'hidden',
    });
    const marked = run(doc, { type: 'setMarks', inUs: 2 * S, outUs: 4 * S });
    expect(faceModeOp(marked, id, 'side-by-side', 3 * S, 300_000)).toEqual({
      type: 'setFaceMode',
      trackId: id,
      startUs: 2 * S,
      endUs: 4 * S,
      mode: 'side-by-side',
      easeUs: 300_000,
    });
  });

  it('adds a keyframe that keeps what is shown', () => {
    const doc = project();
    const id = faceTrack(doc)!.id;
    const added = run(doc, addKeyframeOp(id, 4 * S));
    expect(faceTrack(added)!.layoutKeyframes?.map((k) => k.tUs)).toEqual([0, 4 * S]);
    expect(sceneAt(added, 6 * S).layers).toEqual(sceneAt(doc, 6 * S).layers);
  });

  it('keeps colour opacity in #RRGGBBAA', () => {
    expect(withAlpha('#102030', 0.5)).toBe('#10203080');
    expect(withAlpha('#10203040', 1)).toBe('#102030FF');
    expect(alphaOf('#00000080')).toBeCloseTo(0.5, 2);
    expect(alphaOf('#000000')).toBe(1);
  });
});

describe('preview face box', () => {
  it('is the overlay box while settled in overlay mode, and absent otherwise', () => {
    const doc = keyed();
    const id = faceTrack(doc)!.id;
    const layer = (t: number) => sceneAt(doc, t).layers.find((l) => l.trackId === id)!;
    expect(faceBoxAt(doc, 2 * S)).toEqual(layer(2 * S).destRect);
    expect(faceBoxAt(doc, 6 * S)).toBeNull(); // full screen
    const eased = run(project(), {
      type: 'setFaceMode',
      trackId: id,
      startUs: 5 * S,
      endUs: 8 * S,
      mode: 'full',
      easeUs: S,
    });
    expect(faceBoxAt(eased, 4.5 * S)).toBeNull(); // moving
    expect(faceBoxAt(eased, 2 * S)).not.toBeNull();
  });
});

describe('timeline keyframe lane', () => {
  it('hits a keyframe only in the face row’s lane, near its diamond', () => {
    const doc = keyed();
    const { rows } = layoutRows(doc);
    const faceRow = rows.find((r) => r.track.name === 'Face')!;
    const view = { pxPerSec: 20, scrollUs: 0 };
    const laneY = faceRow.top + faceRow.height - KEYFRAME_LANE_PX / 2;
    const x = timeToX(view, 5 * S);
    expect(hitTest(rows, view, x + 3, laneY)).toMatchObject({
      kind: 'keyframe',
      trackId: faceRow.track.id,
      keyUs: 5 * S,
    });
    expect(hitTest(rows, view, x + 20, laneY).kind).not.toBe('keyframe');
    expect(hitTest(rows, view, x, faceRow.top + 4).kind).not.toBe('keyframe');
  });
});

describe('Delete with a selected keyframe', () => {
  it('removes the keyframe (one undo step) and leaves clips alone', () => {
    const docStore = createDocumentStore({ opOptions: { generateId: counterIds('D') } });
    const doc = keyed();
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
    const id = faceTrack(doc)!.id;
    const clips = docStore.getState().doc!.timeline.tracks.map((t) => t.clips.length);
    ui.getState().selectKeyframe({ trackId: id, tUs: 5 * S });
    runCommand('delete', ctx);
    const after = docStore.getState().doc!;
    expect(faceTrack(after)!.layoutKeyframes?.some((k) => k.tUs === 5 * S)).toBe(false);
    expect(after.timeline.tracks.map((t) => t.clips.length)).toEqual(clips);
    expect(ui.getState().selectedKeyframe).toBeNull();
    expect(docStore.getState().undoLabel).toBe('Delete layout keyframe');
    runCommand('undo', ctx);
    expect(docStore.getState().doc).toEqual(doc);
  });

  it('selecting clips clears the keyframe selection, and the other way round', () => {
    const ui = createUiStore();
    ui.getState().select(['clp_a']);
    ui.getState().selectKeyframe({ trackId: 'trk_f', tUs: 0 });
    expect(ui.getState().selection).toEqual([]);
    ui.getState().select(['clp_a']);
    expect(ui.getState().selectedKeyframe).toBeNull();
  });
});
