/**
 * Inspector → operations (step 18; R1.40–R1.42), the on-canvas face handles and the
 * compositor's geometry (R1.48: the same rects as the render plan).
 */
import { describe, expect, it } from 'vitest';
import {
  cornerOp,
  cropOp,
  faceTrack,
  gainOp,
  mirrorOp,
  nudgeOp,
  overlayRectOp,
  radiusOp,
  resetGainOp,
  screenTrack,
  shapeOp,
  sizeOp,
  sizePresetOp,
  syncComponents,
  toggleOp,
} from '../../src/renderer/editor/InspectorPanel/inspector-ops';
import {
  maskUniforms,
  parseHexColor,
  quadUvs,
  quadVertices,
} from '../../src/renderer/editor/preview/compositor-math';
import {
  canvasToDisplay,
  containTransform,
  displayToCanvas,
  dragOverlayRect,
  hitOverlay,
} from '../../src/renderer/editor/preview/overlay-geometry';
import { overlayDestRect } from '../../src/shared/project/face-layout';
import { layersAt } from '../../src/shared/project/render-plan';
import type { ProjectV1 } from '../../src/shared/project/schema';
import { applyOp, trackFrameSize, type TimelineOp } from '../../src/shared/project/timeline-ops';
import { unwrap } from '../../src/shared/result';
import { exampleProject } from '../fixtures/example-project';

const S = 1_000_000;
const run = (doc: ProjectV1, op: TimelineOp | null) => unwrap(applyOp(doc, op!));

describe('track controls (R1.40)', () => {
  it('maps gain, reset and toggles to operations', () => {
    expect(gainOp('trk_v', -80)).toEqual({ type: 'setGain', trackId: 'trk_v', gainDb: -60 });
    expect(gainOp('trk_v', 3.3)).toEqual({ type: 'setGain', trackId: 'trk_v', gainDb: 3.3 });
    expect(resetGainOp('trk_v')).toEqual({ type: 'setGain', trackId: 'trk_v', gainDb: 0 });
    const doc = exampleProject();
    const voice = doc.timeline.tracks[2]!;
    const screen = doc.timeline.tracks[0]!;
    expect(toggleOp(voice, 'mute')).toEqual({ type: 'setMuted', trackId: 'trk_v', muted: true });
    expect(toggleOp(voice, 'solo')).toEqual({ type: 'setSolo', trackId: 'trk_v', solo: true });
    expect(toggleOp(voice, 'hide')).toBeNull();
    expect(toggleOp(screen, 'hide')).toEqual({ type: 'setHidden', trackId: 'trk_s', hidden: true });
    expect(toggleOp(screen, 'mute')).toBeNull();
    expect(toggleOp(screen, 'lock')).toEqual({ type: 'setLocked', trackId: 'trk_s', locked: true });
    const stepped = run(doc, gainOp('trk_v', 3.3));
    expect(stepped.timeline.tracks[2]).toMatchObject({ gainDb: 3.5 });
  });
});

describe('face overlay panel (R1.41)', () => {
  const doc = exampleProject();
  const face = faceTrack(doc)!;
  const canvas = doc.timeline.canvas;

  it('finds the face and screen tracks', () => {
    expect(face.id).toBe('trk_f');
    expect(screenTrack(doc)?.id).toBe('trk_s');
  });

  it('moves the overlay to each corner with the margin, inside the canvas', () => {
    const topLeft = run(doc, cornerOp(doc, face.id, 'top-left'));
    const layout = faceTrack(topLeft)!.layout;
    const rect = overlayDestRect(layout, canvas, trackFrameSize(topLeft, faceTrack(topLeft)!));
    expect(rect.x).toBe(Math.round(0.03 * 1080));
    expect(rect.y).toBe(Math.round(0.03 * 1080));
    const bottomRight = run(doc, cornerOp(doc, face.id, 'bottom-right'));
    const br = overlayDestRect(faceTrack(bottomRight)!.layout, canvas, {
      width: 1280,
      height: 720,
    });
    expect(br.x + br.width).toBe(1920 - Math.round(0.03 * 1080));
    expect(cornerOp(doc, 'trk_s', 'top-left')).toBeNull();
  });

  it('sizes, shapes, rounds, mirrors and crops', () => {
    expect(faceTrack(run(doc, sizeOp(face.id, 0.9)))!.layout.width).toBe(0.5);
    expect(faceTrack(run(doc, sizeOp(face.id, 0.01)))!.layout.width).toBe(0.05);
    expect(faceTrack(run(doc, sizePresetOp(doc, face.id, 'large')))!.layout.width).toBe(0.3);
    expect(faceTrack(run(doc, shapeOp(face.id, 'rounded')))!.layout.shape).toBe('rounded');
    expect(faceTrack(run(doc, radiusOp(face.id, 0.8)))!.layout.cornerRadius).toBe(0.5);
    expect(faceTrack(run(doc, mirrorOp(face.id, true)))!.layout.mirror).toBe(true);
    const cropped = run(doc, cropOp(face.id, { x: 100, y: 0, width: 5000, height: 720 }));
    expect(faceTrack(cropped)!.layout.crop).toEqual({ x: 100, y: 0, width: 1180, height: 720 });
    expect(faceTrack(run(cropped, cropOp(face.id, null)))!.layout.crop).toBeNull();
    const screenCrop = run(doc, cropOp('trk_s', { x: 10, y: 20, width: 640, height: 360 }));
    expect(screenTrack(screenCrop)!.layout).toMatchObject({
      crop: { x: 10, y: 20, width: 640, height: 360 },
    });
  });

  it('turns a dragged box back into a layout that stays inside the canvas', () => {
    const next = run(
      doc,
      overlayRectOp(doc, face.id, { x: -500, y: 100, width: 300, height: 300 }),
    );
    const rect = overlayDestRect(faceTrack(next)!.layout, canvas, { width: 1280, height: 720 });
    expect(rect.x).toBe(0);
    expect(rect.width).toBe(300);
    expect(rect.y + rect.height).toBeLessThanOrEqual(1080);
  });
});

describe('sync nudge (R1.42)', () => {
  it('maps ms to a clamped component nudge and lists the recorded clock info', () => {
    expect(nudgeOp('cmp_face', 12.4)).toEqual({
      type: 'nudge',
      target: { componentId: 'cmp_face' },
      syncAdjustUs: 12_000,
    });
    expect(nudgeOp('cmp_face', -9000)).toMatchObject({ syncAdjustUs: -2_000_000 });
    const doc = exampleProject();
    doc.media[3]!.sync = {
      mode: 'arrival-calibrated',
      offsetUs: 0,
      clockHandshakeUs: 9,
      outputLatencyUs: 42_667,
    };
    const nudged = run(doc, nudgeOp('cmp_sys', 35));
    const list = syncComponents(nudged);
    expect(list.map((c) => [c.label, c.offsetMs])).toEqual([
      ['Face + Voice', 0],
      ['System audio', 35],
    ]);
    expect(list[1]!.media[0]).toMatchObject({
      role: 'system-audio',
      mode: 'arrival-calibrated',
      outputLatencyMs: 42.667,
      clockHandshakeMs: 0.009,
      driftPpm: -5,
    });
    expect(list[0]!.media.map((m) => m.driftPpm)).toEqual([0, 18.3]);
    // Clips do not move.
    expect(nudged.timeline).toEqual(doc.timeline);
  });
});

describe('preview face handles', () => {
  it('maps between the displayed preview and canvas pixels', () => {
    const t = containTransform({ width: 960, height: 800 }, { width: 1920, height: 1080 });
    expect(t).toEqual({ scale: 0.5, offsetX: 0, offsetY: 130 });
    expect(canvasToDisplay(t, { x: 100, y: 100, width: 200, height: 100 })).toEqual({
      x: 50,
      y: 180,
      width: 100,
      height: 50,
    });
    expect(displayToCanvas(t, 50, 180)).toEqual({ x: 100, y: 100 });
  });

  it('hits corners before the body', () => {
    const box = { x: 100, y: 100, width: 200, height: 100 };
    expect(hitOverlay(box, 102, 98)).toBe('nw');
    expect(hitOverlay(box, 300, 200)).toBe('se');
    expect(hitOverlay(box, 298, 101)).toBe('ne');
    expect(hitOverlay(box, 100, 199)).toBe('sw');
    expect(hitOverlay(box, 200, 150)).toBe('move');
    expect(hitOverlay(box, 50, 50)).toBeNull();
  });

  it('moves, and resizes from a corner with the aspect locked and the opposite corner fixed', () => {
    const start = { x: 100, y: 100, width: 200, height: 100 };
    expect(dragOverlayRect(start, 'move', 10, -5)).toEqual({
      x: 110,
      y: 95,
      width: 200,
      height: 100,
    });
    const se = dragOverlayRect(start, 'se', 40, 0);
    expect(se).toEqual({ x: 100, y: 100, width: 240, height: 120 });
    const nw = dragOverlayRect(start, 'nw', -40, 0);
    expect(nw).toEqual({ x: 60, y: 80, width: 240, height: 120 });
    const ne = dragOverlayRect(start, 'ne', 0, -50); // vertical drag dominates
    expect(ne).toEqual({ x: 100, y: 50, width: 300, height: 150 });
    expect(dragOverlayRect(start, 'sw', 500, 0).width).toBe(16);
  });
});

describe('compositor geometry (R1.48)', () => {
  it('draws each render-plan layer at its integer destination rect with its source UVs', () => {
    const doc = exampleProject();
    const [screen, face] = layersAt(doc, 60 * S);
    const canvas = doc.timeline.canvas;
    expect(Array.from(quadVertices({ x: 0, y: 0, width: 1920, height: 1080 }, canvas))).toEqual([
      -1, 1, 1, 1, -1, -1, 1, -1,
    ]);
    const q = quadVertices(face!.destRect, canvas);
    expect(((q[0]! + 1) / 2) * 1920).toBeCloseTo(face!.destRect.x, 2);
    expect(((1 - q[1]!) / 2) * 1080).toBeCloseTo(face!.destRect.y, 2);
    const uvs = Array.from(quadUvs(screen!.sourceRect, { width: 2880, height: 1800 }, false));
    const expected = [0, 0, 1920 / 2880, 0, 0, 1080 / 1800, 1920 / 2880, 1080 / 1800];
    uvs.forEach((u, i) => expect(u).toBeCloseTo(expected[i]!, 6));
    const mirrored = quadUvs(
      { x: 0, y: 0, width: 100, height: 50 },
      { width: 200, height: 100 },
      true,
    );
    expect(Array.from(mirrored)).toEqual([0.5, 0, 0, 0, 0.5, 0.5, 0, 0.5]);
    expect(maskUniforms(face!)).toEqual({
      rect: [face!.destRect.x, face!.destRect.y, face!.destRect.width, face!.destRect.height],
      radius: face!.destRect.width / 2,
    });
  });

  it('parses the background colour', () => {
    expect(parseHexColor('#ff8000')).toEqual([1, 128 / 255, 0, 1]);
    expect(parseHexColor('#00000080')).toEqual([0, 0, 0, 128 / 255]);
    expect(parseHexColor('red')).toEqual([0, 0, 0, 1]);
  });
});
