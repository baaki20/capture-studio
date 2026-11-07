/**
 * Picture backgrounds (R2.11): the setBeautify op adds the picture in the same step and checks
 * it; the invariant catches a missing picture; the scene draws it first, cropped to cover the
 * canvas; the inspector helpers keep or drop the picture.
 */
import { describe, expect, it } from 'vitest';
import {
  backgroundCss,
  imageBackgroundOp,
  withFillColor,
  withoutPicture,
} from '../../src/renderer/editor/InspectorPanel/screen-style-ops';
import { checkProjectInvariants } from '../../src/shared/project/invariants';
import { importedMediaEntry } from '../../src/shared/project/media-import';
import { backgroundLayer, sceneAt } from '../../src/shared/project/scene';
import type { Media, Project } from '../../src/shared/project/schema';
import { applyOp } from '../../src/shared/project/timeline-ops';
import { unwrap } from '../../src/shared/result';
import { counterIds, recordedProject } from '../fixtures/editor-project';

const PIC = 'med_01JBQ4ZJ4X6V3K8N2M7P5R9PIC';

function project(): Project {
  return recordedProject({
    durationUs: 4_000_000,
    pauses: [],
    system: false,
    screenSize: { width: 1920, height: 1080 },
    cameraSize: { width: 640, height: 480 },
    offsets: { screen: 0, camera: 0, microphone: 0 },
  });
}

function picture(width: number, height: number, kind: 'video' | 'audio' = 'video'): Media {
  return importedMediaEntry(PIC, 'media/background.mp4', {
    kind,
    durationUs: 33_334,
    ...(kind === 'video'
      ? { video: { codec: 'h264', width, height, frameRateNominal: 30 } }
      : { audio: { codec: 'aac', sampleRate: 48_000, channels: 2 } }),
  });
}

const generateId = counterIds('I');

describe('picture background', () => {
  it('adds the picture and the background in one step', () => {
    const doc = project();
    const op = imageBackgroundOp(doc, picture(1600, 1200));
    const next = unwrap(applyOp(doc, op, { generateId }));
    expect(next.media.map((m) => m.id)).toContain(PIC);
    expect(next.timeline.beautify?.background).toEqual({
      type: 'image',
      mediaId: PIC,
      color: '#000000', // no styled background yet: black
    });
    expect(checkProjectInvariants(next)).toEqual([]);
    expect(doc.media.some((m) => m.id === PIC)).toBe(false);
  });

  it('refuses unknown media, sound files and duplicate media', () => {
    const doc = project();
    const bad = applyOp(
      doc,
      {
        type: 'setBeautify',
        beautify: {
          background: { type: 'image', mediaId: PIC, color: '#000000' },
          padding: 0,
          cornerRadius: 0,
        },
      },
      { generateId },
    );
    expect(bad.ok).toBe(false);
    expect(applyOp(doc, imageBackgroundOp(doc, picture(1, 1, 'audio')), { generateId }).ok).toBe(
      false,
    );
    const once = unwrap(applyOp(doc, imageBackgroundOp(doc, picture(800, 600)), { generateId }));
    expect(applyOp(once, imageBackgroundOp(once, picture(800, 600)), { generateId }).ok).toBe(
      false,
    );
  });

  it('is an invariant violation when the picture is gone', () => {
    const doc = unwrap(
      applyOp(project(), imageBackgroundOp(project(), picture(800, 600)), { generateId }),
    );
    const broken = { ...doc, media: doc.media.filter((m) => m.id !== PIC) };
    expect(checkProjectInvariants(broken).map((v) => v.code)).toContain('missing-media');
  });

  it('is drawn first, cropped to cover the canvas', () => {
    const doc = unwrap(
      applyOp(project(), imageBackgroundOp(project(), picture(1600, 1200)), { generateId }),
    );
    const scene = sceneAt(doc, 1_000_000);
    expect(scene.layers[0]).toMatchObject({
      mediaId: PIC,
      // 4:3 on a 16:9 canvas: full width, the middle 900 rows.
      sourceRect: { x: 0, y: 150, width: 1600, height: 900 },
      destRect: { x: 0, y: 0, width: 1920, height: 1080 },
      fileTimeUs: 0,
    });
    expect(scene.layers.length).toBeGreaterThan(1);
    const tall = unwrap(
      applyOp(project(), imageBackgroundOp(project(), picture(1000, 2000)), { generateId }),
    );
    expect(backgroundLayer(tall)?.sourceRect).toEqual({ x: 0, y: 718, width: 1000, height: 563 });
    expect(backgroundLayer(project())).toBeNull();
  });

  it('keeps the picture when the fill colour changes, and removing it keeps the colour', () => {
    const image = { type: 'image' as const, mediaId: PIC, color: '#112233' };
    expect(withFillColor(image, '#445566')).toEqual({ ...image, color: '#445566' });
    expect(withoutPicture(image)).toEqual({ type: 'color', color: '#112233' });
    expect(withFillColor({ type: 'color', color: '#000000' }, '#FFFFFF')).toEqual({
      type: 'color',
      color: '#FFFFFF',
    });
    expect(backgroundCss(image)).toBe('#112233');
  });
});
